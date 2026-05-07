# TODO — TypeScript Migration

## Service
- [ ] Install TypeScript devDeps (typescript, ts-jest, tsx, @types/*)
- [ ] Create service/tsconfig.json
- [ ] Convert service/src/chunker.js → chunker.ts
- [ ] Convert service/src/influence.js → influence.ts
- [ ] Convert service/src/db.js → db.ts
- [ ] Convert service/src/embeddings.js → embeddings.ts
- [ ] Convert service/src/server.js → server.ts
- [ ] Convert service/tests/chunker.test.js → chunker.test.ts
- [ ] Convert service/tests/influence.test.js → influence.test.ts
- [ ] Delete old .js source files
- [ ] Update service/package.json (scripts + jest config)
- [ ] Run tests — must pass
- [ ] Run npm run build — must succeed

## Viewer
- [ ] Update viewer/package.json (typescript + @types/react + @types/react-dom)
- [ ] Create viewer/tsconfig.json
- [ ] Rename .jsx → .tsx (4 files, fix imports)
- [ ] Update viewer/index.html

## Deploy
- [ ] git diff --staged review
- [ ] Commit + push + PR + merge
