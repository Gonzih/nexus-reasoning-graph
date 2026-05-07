# PLAN: TypeScript Migration — service layer

## Task (restated)
Convert `service/` from JavaScript (CommonJS) to TypeScript with proper types and passing tests. Rename `viewer/src/*.jsx` → `.tsx`. No logic changes — types and file renames only.

## Approach: tsx (dev) + tsc (build)
- `tsc` compiles `src/**/*.ts` → `dist/`, `npm start` runs `node dist/server.js`
- `tsx watch src/server.ts` for fast dev iteration
- `ts-jest` with `isolatedModules: true` for tests

## Files to touch

### service/
- Create `service/tsconfig.json`
- Update `service/package.json` (devDeps + scripts + jest config)
- service/src/*.js → *.ts (5 files)
- service/tests/*.test.js → *.test.ts (2 files)

### viewer/
- Create `viewer/tsconfig.json`
- Update `viewer/package.json` (typescript + @types/react + @types/react-dom)
- viewer/src/**/*.jsx → *.tsx (4 files)
- Update `viewer/index.html` (main.jsx → main.tsx)

## Key type decisions
- `chunker.ts`: param typed `string | null | undefined` to preserve null-safe test
- `db.ts`: typed row interfaces; cast `Statement.get()` results (returns `unknown`)
- `embeddings.ts`: `EmbeddingProvider` union type; type xenova pipeline inline
- `influence.ts`: `ChunkInput`, `InfluenceEdge` interfaces
- `server.ts`: typed Express request bodies via generics
- Tests: `import` syntax, ts-jest handles transpilation
- Viewer: `strict: false` to avoid D3/React annotation churn

## Risks
- `@types/better-sqlite3` compatibility → mitigated with `skipLibCheck: true`
- `@xenova/transformers` no @types → type pipeline callable inline
