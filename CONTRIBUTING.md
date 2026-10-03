# Contributing to Wayroost

Thanks for helping! Wayroost controls coding agents that can run commands on
someone's machine, so correctness and safety come first.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Security problems: report them privately (see [SECURITY.md](SECURITY.md)),
  not in an issue or pull request.

## Development setup

```bash
git clone https://github.com/vankoala/wayroost
cd wayroost
npm ci --ignore-scripts
npm test
npm run build:web && npm run demo    # http://127.0.0.1:8890 with demo data
```

See [docs/development.md](docs/development.md) for the layout, the test suites
and the Paseo compatibility harness.

## Pull requests

- `npm run typecheck`, `npm test` and `npm run build` must pass. CI also runs a
  headless-browser UI check and the Paseo compatibility harness.
- Add or update tests for behavior changes. For request handling, auth,
  rendering of agent output or approvals, tests are required.
- Keep the security properties described in [SECURITY.md](SECURITY.md) true. If
  a change weakens one, say so explicitly in the PR description.
- Match the existing style: TypeScript strict mode, small focused modules, short
  comments that explain *why*.
- UI changes: attach phone-size screenshots (`npm run check:ui` writes them to
  `ui-shots/`).
- Don't use real conversations from your own agents in tests, screenshots or
  bug reports. Use the demo data.
- Never commit a real config, tunnel credential or saved sign-in. The
  `.gitignore` covers the usual files; only the templates in `deploy/` belong
  in git.

## Adding support for another agent runtime

Each backend is an adapter that maps its API into `shared/protocol.ts`
(conversations, timeline items, approvals). Look at `server/src/paseo/` and
`server/src/hermes/`, implement the `ConversationSource` interface in
`server/src/sources.ts`, and add a fake or harness that tests the adapter
without real credentials.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0 (see [LICENSE](LICENSE)).
