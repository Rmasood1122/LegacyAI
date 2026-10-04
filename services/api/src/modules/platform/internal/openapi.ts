// Loads services/api/openapi.yaml and turns it into request and response validators.
// The YAML file is the source of truth: routes take their method, path, permission,
// idempotency flag and validation from it, so code cannot drift from the contract.
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

type Json = Record<string, unknown>;

export interface Operation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  fastifyPath: string;
  permission: string | null;
  /** The contract says `x-api-key: true`: a machine's API key is accepted here as well as a signed-in session. */
  apiKey: boolean;
  isPublic: boolean;
  isService: boolean;
  idempotent: boolean;
  /** False where the contract lists the Idempotency-Key header as optional: it is honoured when sent. */
  idempotencyKeyRequired: boolean;
  /**
   * `x-one-time-secrets`: the fields of this operation's answer that are shown ONCE (a secret code, an enrollment
   * token, an API key). They are removed before the answer is kept for a retried request.
   */
  oneTimeSecrets: readonly string[];
  hasBody: boolean;
  /** The contract says `requestBody.required: false` in so many words: a request with NO body is then accepted as it is. */
  bodyOptional: boolean;
  /** Content types of a raw-file body (uploads). Empty for JSON operations. */
  binaryTypes: string[];
  validateBody: ValidateFunction | null;
  validateParams: ValidateFunction | null;
  validateQuery: ValidateFunction | null;
  validateIdempotencyKey: ValidateFunction | null;
  /** status -> validator (null = the contract says "no body"). */
  responses: Map<number, ValidateFunction | null>;
}

export interface Contract {
  operations: Map<string, Operation>;
  validateProblem: ValidateFunction;
}

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;

function deref(node: unknown, root: Json, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(n, root, seen));
  if (typeof node !== 'object' || node === null) return node;
  const obj = node as Json;
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    if (!ref.startsWith('#/')) throw new Error(`openapi: only local $ref is supported, got ${ref}`);
    if (seen.includes(ref)) throw new Error(`openapi: circular $ref ${ref}`);
    let target: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      target = (target as Json | undefined)?.[part];
    }
    if (target === undefined) throw new Error(`openapi: unresolved $ref ${ref}`);
    return deref(target, root, [...seen, ref]);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deref(v, root, seen);
  return out;
}

/** Every property name anywhere in a (dereferenced) schema. */
function propertyNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) propertyNames(n, into);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) for (const name of Object.keys(v)) into.add(name);
    propertyNames(v, into);
  }
}

export function loadContract(filePath: string): Contract {
  const root = parse(readFileSync(filePath, 'utf8')) as Json;
  const doc = deref(root, root) as Json;

  const strict = new Ajv2020({ allErrors: true, strict: false });
  addFormats(strict);
  // Query strings arrive as text; coerce "25" to 25 and fill in declared defaults.
  const coercing = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
  addFormats(coercing);
  // The stock "uuid" format also accepts "urn:uuid:..." and upper case, which PostgreSQL or our
  // own checks would then reject with an error. One canonical spelling only.
  const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  strict.addFormat('uuid', canonicalUuid);
  coercing.addFormat('uuid', canonicalUuid);

  const operations = new Map<string, Operation>();
  const answerFieldsOf = new Map<string, Set<string>>();
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      const operationId = op.operationId;
      if (typeof operationId !== 'string') throw new Error(`openapi: ${method} ${path} has no operationId`);
      if (operations.has(operationId)) throw new Error(`openapi: duplicate operationId ${operationId}`);

      const parameters = (op.parameters ?? []) as Json[];
      const group = (where: string): ValidateFunction | null => {
        const list = parameters.filter((p) => p.in === where);
        if (list.length === 0 && where !== 'query') return null;
        return (where === 'query' ? coercing : strict).compile({
          type: 'object',
          additionalProperties: false,
          required: list.filter((p) => p.required === true).map((p) => p.name),
          properties: Object.fromEntries(list.map((p) => [p.name as string, p.schema])),
        });
      };
      const idemParam = parameters.find((p) => p.in === 'header' && p.name === 'Idempotency-Key');

      const bodyContent = ((op.requestBody as Json | undefined)?.content ?? {}) as Json;
      const bodySchema = bodyContent['application/json'] as Json | undefined;
      const binaryTypes = Object.keys(bodyContent).filter((k) => k !== 'application/json');
      const responses = new Map<number, ValidateFunction | null>();
      for (const [status, res] of Object.entries((op.responses ?? {}) as Record<string, Json>)) {
        const content = (res.content ?? {}) as Record<string, Json>;
        const schema = (content['application/json'] ?? content['application/problem+json'])?.schema;
        responses.set(Number(status), schema === undefined ? null : strict.compile(schema as Json));
      }

      const declaredSecrets = op['x-one-time-secrets'] ?? [];
      if (!Array.isArray(declaredSecrets) || !declaredSecrets.every((f) => typeof f === 'string' && /^[a-z_]{1,60}$/.test(f))) {
        throw new Error(`openapi: ${operationId} has a malformed x-one-time-secrets list`);
      }
      const answerFields = new Set<string>();
      for (const res of Object.values((op.responses ?? {}) as Record<string, Json>)) propertyNames((res.content as Json | undefined)?.['application/json'], answerFields);
      for (const f of declaredSecrets as string[]) {
        if (!answerFields.has(f)) throw new Error(`openapi: ${operationId} lists the one-time secret "${f}", which its answers do not contain`);
      }
      answerFieldsOf.set(operationId, answerFields);

      const isPublic = op['x-public'] === true;
      const isService = op['x-service'] === true;
      const permission = typeof op['x-permission'] === 'string' ? op['x-permission'] : null;
      if (op['x-api-key'] === true && (isPublic || isService)) throw new Error(`openapi: ${operationId} is public and cannot take an API key`);
      if (!isPublic && permission === null) {
        throw new Error(`openapi: ${operationId} is not public and declares no x-permission`);
      }
      operations.set(operationId, {
        operationId,
        method: method.toUpperCase() as Operation['method'],
        path,
        fastifyPath: path.replace(/\{([a-z_]+)\}/g, ':$1'),
        permission,
        apiKey: op['x-api-key'] === true,
        isPublic,
        isService,
        idempotent: op['x-idempotent'] === true,
        idempotencyKeyRequired: idemParam?.required === true,
        oneTimeSecrets: declaredSecrets as string[],
        hasBody: bodySchema !== undefined || binaryTypes.length > 0,
        bodyOptional: (op.requestBody as Json | undefined)?.required === false,
        binaryTypes,
        validateBody: bodySchema ? strict.compile(bodySchema.schema as Json) : null,
        validateParams: group('path'),
        validateQuery: group('query'),
        validateIdempotencyKey: idemParam ? strict.compile(idemParam.schema as Json) : null,
        responses,
      });
    }
  }

  // A field that is a one-time secret in ONE operation is one wherever an answer is kept for a retry: an operation
  // that returns it and takes an Idempotency-Key must list it too, or the secret would be stored and shown again.
  const everySecret = new Set([...operations.values()].flatMap((o) => o.oneTimeSecrets));
  for (const o of operations.values()) {
    if (o.validateIdempotencyKey === null) continue;
    for (const f of answerFieldsOf.get(o.operationId) ?? []) {
      if (everySecret.has(f) && !o.oneTimeSecrets.includes(f)) {
        throw new Error(`openapi: ${o.operationId} returns "${f}" and can be retried; list it under x-one-time-secrets`);
      }
    }
  }

  const problemSchema = ((doc.components as Json).schemas as Json).Problem as Json;
  return { operations, validateProblem: strict.compile(problemSchema) };
}

export function validationErrors(validate: ValidateFunction, prefix: string): Array<{ path: string; message: string }> {
  return (validate.errors ?? []).slice(0, 20).map((e) => ({
    path: `${prefix}${e.instancePath}`,
    // Ajv messages describe the rule that failed, never the submitted value.
    message: e.message ?? 'invalid',
  }));
}
