import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// rf.mjs is src/rf-people.ts without its types: Node strips no types under node_modules.
const at = f => new URL(f, import.meta.url);
writeFileSync(at('rf.mjs'), '#!/usr/bin/env node\n' + stripTypeScriptTypes(readFileSync(at('../src/rf-people.ts'), 'utf8')), { mode: 0o755 });
copyFileSync(at('../LICENSE'), at('LICENSE'));
