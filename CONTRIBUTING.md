# Contributing to Warden

Thanks for your interest in contributing. Warden is source-available under PolyForm Shield 1.0.0.

## Reporting bugs

Open a GitHub issue with:
- What you expected
- What happened
- Steps to reproduce
- Your OS, Node version, and agent

## Suggesting features

Open a GitHub issue describing the feature and why it's useful.

## Pull requests

1. Fork the repo
2. Create a branch: `git checkout -b fix/my-fix`
3. Make your changes
4. Run `npm test` — all tests must pass
5. Run `npm run build` — must succeed
6. Submit a PR with a clear description

## Code style

- TypeScript, ESM
- Follow existing patterns in the codebase
- Keep changes surgical — touch only what's needed
- Don't add comments unless explaining non-obvious logic

## Testing

```bash
npm test          # run all 244 tests
npm run build     # verify build
npm run typecheck # verify types
```

All three must pass before a PR can be merged.
