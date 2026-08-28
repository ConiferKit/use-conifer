# @conifer/sdk

**This is not the package you want.** Install [`conifer-sdk`](https://www.npmjs.com/package/conifer-sdk):

```bash
npm i conifer-sdk
```

```ts
import { Conifer, textOf } from "conifer-sdk";
```

## Why this package exists

The Conifer SDK ships **unscoped**, as `conifer-sdk`, on both npm and PyPI —
one name in both ecosystems.

This scoped package exists only so the `@conifer` scope cannot be claimed by
someone else and used to publish something that looks official. It re-exports
`conifer-sdk` verbatim and adds no behavior of its own, so if you installed it
by guessing the name, your code still works. Prefer the real name.

- Source: <https://github.com/ConiferKit/use-conifer>
- Documentation: <https://conifer.build/docs/sdk/conifer/>
- License: Apache-2.0
