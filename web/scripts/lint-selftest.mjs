#!/usr/bin/env node
// Proves the lint rules that carry promises of the design really fire: each deliberate violation
// below must be rejected, and each clean file must pass. Run in CI after the normal lint.
import { ESLint } from 'eslint';

const eslint = new ESLint();
const cases = [
  ['a screen calling fetch directly', 'src/features/ask/Bad.tsx', 'export const load = () => fetch("/v1/sources");\n', true],
  ['window.fetch in a hook', 'src/features/ask/bad.ts', 'export const load = () => window.fetch("/v1/sources");\n', true],
  ['localStorage', 'src/session/bad.ts', 'export const save = (t: string) => localStorage.setItem("token", t);\n', true],
  ['sessionStorage', 'src/features/home/bad.ts', 'export const read = () => window.sessionStorage.getItem("x");\n', true],
  ['raw HTML injection', 'src/ui/Bad.tsx', 'export const X = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n', true],
  ['inline style', 'src/ui/Bad2.tsx', 'export const X = () => <p style={{ color: "red" }}>x</p>;\n', true],
  ['one feature importing another', 'src/features/ask/bad2.ts', 'import { failureText } from "../documents/hooks.ts";\nexport const t = failureText;\n', true],
  ['a feature importing a feature folder that does not exist yet', 'src/features/ask/bad3.ts', 'import { x } from "../brandnew/hooks.ts";\nexport const t = x;\n', true],
  ['a feature reaching another feature the long way round', 'src/features/ask/bad4.ts', 'import { x } from "../../features/home/hooks.ts";\nexport const t = x;\n', true],
  ['a feature importing the screen list', 'src/features/ask/bad5.ts', 'import { SCREENS } from "../../screens.tsx";\nexport const t = SCREENS;\n', true],
  ['a feature importing the application frame', 'src/features/ask/bad6.ts', 'import { App } from "../../App.tsx";\nexport const t = App;\n', true],
  ['a feature using the cache library directly', 'src/features/ask/bad7.ts', 'import { useQueryClient } from "@tanstack/react-query";\nexport const t = useQueryClient;\n', true],
  ['a feature using the API client directly', 'src/features/ask/bad8.ts', 'import { useApi } from "../../api/context.tsx";\nexport const t = useApi;\n', true],
  ['the api layer importing the session', 'src/api/bad.ts', 'import { useSession } from "../session/session.tsx";\nexport const t = useSession;\n', true],
  ['the api layer importing a feature', 'src/api/bad2.ts', 'import { failureText } from "../features/documents/hooks.ts";\nexport const t = failureText;\n', true],
  ['the session importing the design system', 'src/session/bad2.ts', 'import { Button } from "../ui/index.tsx";\nexport const t = Button;\n', true],
  ['the session importing the screen list', 'src/session/bad3.ts', 'import { SCREENS } from "../screens.tsx";\nexport const t = SCREENS;\n', true],
  ['navigation importing a feature', 'src/navigation/bad.ts', 'import { failureText } from "../features/documents/hooks.ts";\nexport const t = failureText;\n', true],
  ['the design system reaching for data', 'src/ui/bad3.ts', 'import { useApi } from "../api/context.tsx";\nexport const u = useApi;\n', true],
  ['a file in a sub-folder of a feature (the isolation rule cannot see through it)', 'src/features/ask/components/Fine.tsx', 'export const X = () => <p>x</p>;\n', true],
  ['a dynamic import (it would slip past the layer rules)', 'src/features/ask/bad9.ts', 'export const load = () => import("../documents/hooks.ts");\n', true],
  ['sendBeacon', 'src/features/ask/bad10.ts', 'export const ping = () => navigator.sendBeacon("/v1/health");\n', true],
  ['a clean presentational component', 'src/ui/Good.tsx', 'export const X = ({ text }: { text: string }) => <p className="muted">{text}</p>;\n', false],
  ['a feature using the data hooks, the session, navigation and its own files', 'src/features/ask/good.ts',
    'import { useApiQuery } from "../../api/context.tsx";\nimport { useSession } from "../../session/session.tsx";\nimport { screenPath } from "../../navigation/routes.ts";\nimport { x } from "./own.ts";\nexport const t = [useApiQuery, useSession, screenPath, x];\n', false],
  ['the session using the API client', 'src/session/good.ts', 'import { useApi } from "../api/context.tsx";\nexport const t = useApi;\n', false],
];
let failed = 0;
for (const [what, filePath, code, shouldFail] of cases) {
  const [result] = await eslint.lintText(code, { filePath });
  const rejected = (result?.errorCount ?? 0) > 0;
  if (rejected !== shouldFail) {
    failed += 1;
    console.error(`web-lint-selftest: WRONG - "${what}" was ${rejected ? 'rejected' : 'accepted'}${rejected ? `: ${result.messages.map((m) => m.message).join(' | ')}` : ''}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`web-lint-selftest: PASS (${cases.filter((c) => c[3]).length} deliberate violations rejected, ${cases.filter((c) => !c[3]).length} clean files accepted)`);
