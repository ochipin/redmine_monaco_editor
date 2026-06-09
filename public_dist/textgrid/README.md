# textgrid

English | [日本語](./README.ja.md)

A spreadsheet-style table-editing UI library compatible with Markdown and Textile.
Distributed as an ES Module that runs directly in the browser (no build step required).

## Features

- **Round-trip Markdown / Textile**: Parse a table string, edit it in an Excel-like grid, then write it back
- **Cell styling**: bold, italic, underline (Textile), background color (Textile), left/center/right alignment
- **Cell merging**: rowSpan / colSpan (writable only in Textile)
- **Excel-like operations**: range selection, add/delete/move rows and columns, copy & paste, undo / redo (styles, structural changes, merges)
- **Tabbed interface**: open multiple tables at once and switch between them
- **Zero runtime dependencies**: pure standard browser APIs

## Install

No NPM package yet. Copy the directory into your project.

```sh
git clone https://github.com/<owner>/textgrid.git
cp -r textgrid /path/to/your/project/lib/
```

## Usage

### Running the demo

> **Important**: ES Modules do not work over the `file://` protocol (CORS restriction).
> The library must be served over HTTP.

```sh
cd textgrid
python3 -m http.server 8000
# Then open http://localhost:8000/demo/ in your browser
```

`npm run demo` does the same.

### HTML

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="./textgrid/styles/textgrid.css">
</head>
<body>
  <div id="wrapper" style="position: relative; width: 800px; height: 600px;"></div>
  <script type="module">
    import { initTableBuilder } from './textgrid/src/index.js';

    const api = initTableBuilder({
      wrapper: document.getElementById('wrapper'),
      format: 'textile',
      t: (key, fallback) => fallback,
      copy: (text) => navigator.clipboard.writeText(text),
      showEditor: () => { /* close-the-builder hook */ },
    });

    api.open();
  </script>
</body>
</html>
```

### ctx parameters

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `wrapper` | `HTMLElement` | yes | Container DOM element. `position: relative` recommended |
| `format` | `'markdown' \| 'textile'` | yes | Table format |
| `t` | `(key, fallback) => string` | yes | i18n callback; can be a passthrough of `fallback` |
| `copy` | `(text: string) => void` | yes | Called when the "Copy table" button is pressed |
| `showEditor` | `() => void` | yes | Called to close the builder and return to the original editor |

### API surface

The return value of `initTableBuilder`:

- **`open()`**: open an empty new table in a new tab
- **`openForText(text, format, commit, key, onClose)`**: open an existing table text for editing
- **`showBody()`**: close the current tab and return to the body
- **`destroy()`**: tear down everything

### Low-level (parsers / serializers)

You can use just the parser/serializer layer without the UI:

```js
import {
  toMarkdown, toTextile,
  parseMarkdown, parseMarkdownWithStyles,
  parseTextile, parseTextileWithStyles,
  parseTsv,
} from './textgrid/src/index.js';
```

See [README.ja.md](./README.ja.md) for the detailed API in Japanese.

## License

MIT
