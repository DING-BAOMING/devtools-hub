// BUG-349: markdown mirror handler — the implementation is shared in libs/page-md.js
// (BUG-114 copied it 3x; W5 `markdown-url-support` fired because /subprocessors/ had none).
// Normal /subprocessors/ requests fall through to the static subprocessors/index.html file.
import { servePageMarkdown } from '../../libs/page-md.js';

export const onRequest = (context) =>
  servePageMarkdown(context, { title: 'Subprocessors \& Third-Party Services', pagePath: '/subprocessors/' });
