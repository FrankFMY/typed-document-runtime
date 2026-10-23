# Third-party notices

The emitted library imports Zod 4.6.6 as a separate runtime dependency.
It does not embed Zod or development tools in its ESM files. Zod is distributed
with its own license; retain the following notice when redistributing Zod,
including when bundling an application that uses this library.

## Zod 4.6.6 — MIT

The following is the complete LICENSE from the pinned Zod distribution.

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

TypeScript, Oxlint, Vite, Playwright and Bun type declarations are development
dependencies. Their implementations and browser binaries are not included in
this package archive. Their own distributions retain their respective license
files. This notice does not relicense any dependency.
