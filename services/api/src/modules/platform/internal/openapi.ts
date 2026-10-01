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
  isPublic: boolean;
  isService: boolean;
  idempotent: boolean;
  hasBody: boolean;
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

export function loadContract(filePath: string): Contract {
  const root = parse(readFileSync(filePath, 'utf8')) as Json;
  const doc = deref(root, root) as Json;

  const strict = new Ajv2020({ allErrors: true, strict: false });
  addFormats(strict);
  // Query strings arrive as text; coerce "25" to 25 and fill in declared defaults.
  const coercing = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
  addFormats(coercing);

  const operations = new Map<string, Operation>();
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

      const bodySchema = ((op.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as Json | undefined;
      const responses = new Map<number, ValidateFunction | null>();
      for (const [status, res] of Object.entries((op.responses ?? {}) as Record<string, Json>)) {
        const content = (res.content ?? {}) as Record<string, Json>;
        const schema = (content['application/json'] ?? content['application/problem+json'])?.schema;
        responses.set(Number(status), schema === undefined ? null : strict.compile(schema as Json));
      }

      const isPublic = op['x-public'] === true;
      const isService = op['x-service'] === true;
      const permission = typeof op['x-permission'] === 'string' ? op['x-permission'] : null;
      if (!isPublic && permission === null) {
        throw new Error(`openapi: ${operationId} is not public and declares no x-permission`);
      }
      operations.set(operationId, {
        operationId,
        method: method.toUpperCase() as Operation['method'],
        path,
        fastifyPath: path.replace(/\{([a-z_]+)\}/g, ':$1'),
        permission,
        isPublic,
        isService,
        idempotent: op['x-idempotent'] === true,
        hasBody: bodySchema !== undefined,
        validateBody: bodySchema ? strict.compile(bodySchema.schema as Json) : null,
        validateParams: group('path'),
        validateQuery: group('query'),
        validateIdempotencyKey: idemParam ? strict.compile(idemParam.schema as Json) : null,
        responses,
      });
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
