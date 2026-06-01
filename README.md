# Redmine Monaco Editor

**English** | [日本語](README.ja.md)

**A drop-in plugin that turns Redmine's somewhat clunky text editor into a VS Code-class writing experience.**

Ever wished Redmine's ticket and wiki editor were a little easier to write in? This plugin replaces Redmine's default textarea with the [Monaco Editor](https://microsoft.github.io/monaco-editor/) (the engine that powers VS Code). You get syntax highlighting, live preview, an outline view, and more — making long procedures and design notes far more comfortable to write.

![](docs/image.png)

It never connects to any external CDN or API. Monaco itself is bundled inside the plugin, so **it works as-is in closed environments with no internet access (on-premise / internal networks).**

## Features

**VS Code syntax highlighting**
Markdown is highlighted, and so is the content inside code blocks, colored per language. Major languages such as bash, SQL, Python, Go, Rust, and YAML are supported, so commands and code pasted into procedures stay readable.

**Four view modes**
Switch between "edit only", "editor + preview side by side", "stacked (top/bottom)", and "preview only" with a single click. Split mode is handy when you want to check the result as you write. The preview is rendered with the same look as Redmine's native preview (section numbers, theme styling, etc.).

**Free resizing**
Both the editor height and the boundary between split panes can be dragged to any size you like.

**Scroll sync**
In split mode, scrolling the editor moves the preview to the corresponding position. You won't lose track of where you are, even in long documents.

**Outline panel**
Show a list of headings in a side panel. The hierarchy is expressed with indentation, and clicking a heading jumps to it. Great for grasping the structure of a long wiki page or quickly moving to a target section.

**Ticket number tooltips**
Hover over a ticket reference such as `#1010` or `#89-3` and a tooltip gently shows that ticket's information. You can check the content without opening the link.

**@mention completion**
Type `@` to bring up member candidates. Fuzzy matching is supported, and even if you pick by display name it is automatically converted to the internal login ID, so you can enter mentions accurately and quickly. Tooltips are shown for candidates and confirmed mentions too.

**Formatting toolbar**
Insert bold, italic, underline, strikethrough, inline code, headings (H1–H4), bulleted lists, numbered lists, quotes, and code blocks from buttons. They work both by wrapping a selection and by inserting at the cursor. Keyboard shortcuts `Ctrl+B` (bold) and `Ctrl+I` (italic) are supported as well.

**Table grid insertion**
Click the table button and a grid appears; just pick the rows × columns with your mouse (like "3×4") to insert a table skeleton. You can start building tables with an Excel/Word-like feel.

**Image insertion**
Pick an image attached to the ticket/wiki from a thumbnail list and insert it. Images that were just uploaded but not yet saved also appear as candidates. When duplicate file names exist, the newer one takes precedence, and hovering shows the date.

**File link insertion**
Insert a link to an attachment (`attachment:filename`) by picking it from a list. Each file type — Excel, Word, PDF, PowerPoint, image, code, config file, and more — gets its own icon so you can tell them apart at a glance. Hovering shows the file name, description, and date.

**Markdown and Textile support**
Works whether Redmine is set to Markdown or Textile. The toolbar buttons automatically emit the correct markup for the active format, so you get the same operation feel in either environment.

## Tested environment

- Redmine 6.1 (Propshaft environment)
- Text formatting: both Markdown and Textile are supported (select under "Administration > Settings > General")
- UI language: Japanese and English (follows the Redmine per-user language setting automatically)

## Directory layout

```
redmine_monaco_editor/
├── init.rb                          # Plugin registration + ViewHook (injects the i18n dictionary)
├── config/
│   └── locales/
│       ├── en.yml                   # UI strings (English)
│       └── ja.yml                   # UI strings (Japanese)
├── assets/
│   ├── javascripts/monaco_editor.js # Main script
│   └── stylesheets/monaco_editor.css
├── public_dist/
│   └── vs/                          # Monaco itself (copy to public/monaco_assets/vs/)
├── LICENSE
└── README.md
```

## Installation

### Step 1: Place the plugin

Put the `redmine_monaco_editor` directory under Redmine's `plugins/`.

```
<REDMINE_ROOT>/plugins/redmine_monaco_editor/
```

### Step 2: Place Monaco (vs/) directly under public/ ★IMPORTANT★

This is the key step of this plugin. **Copy `public_dist/vs/` to Redmine's `public/monaco_assets/vs/`.**

```bash
mkdir -p <REDMINE_ROOT>/public/monaco_assets
cp -r <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist/vs \
      <REDMINE_ROOT>/public/monaco_assets/vs
```

After placing it, you're good if the following file exists:

```
<REDMINE_ROOT>/public/monaco_assets/vs/loader.js
```

### Step 3: Restart Redmine

Restart your web server (Puma / Passenger, etc.).

### Verify

Open a ticket or wiki edit screen in your browser; if the editor has changed to Monaco, it worked. You can also confirm by accessing `<host>/monaco_assets/vs/loader.js` directly and getting a 200 response.

## Why place it under public/ (technical background)

You might think "Step 2 is a bit of a hassle," but there's a reason rooted in Redmine 6.

Redmine 6's asset pipeline (Propshaft) serves assets only via hashed URLs (`/assets/....-<hash>.js`). Monaco Editor, on the other hand, is designed to **dynamically load many sub-files via plain paths (no hash)** starting from `vs/loader.js` (e.g. `vs/editor/...`). So if placed under Propshaft management, those plain paths return 404 and it won't work.

That's why only `vs/` is placed directly under `public/`. Files under public are served statically by Rails with their plain paths (bypassing Propshaft), so Monaco's loader works correctly.

- `monaco_editor.js` / `monaco_editor.css` … normal plugin assets (served by Redmine via `javascript_include_tag` / `stylesheet_link_tag`)
- `vs/` … placed at `public/monaco_assets/vs/` and served with plain paths (`/monaco_assets/vs/...`)

The JS side is hard-configured to reference `/monaco_assets/vs` (see `getMonacoBase()` in `monaco_editor.js`). If you want to change the placement, update this function's return value accordingly.

## Automating the copy on every update

The Step 2 copy needs to be done each time you update the plugin. Depending on your environment, integrating it into the startup process removes the need to copy manually.

### Docker (official redmine image, etc.)

In setups where `public/` is reset on container start, add the copy step to your entrypoint script.

```bash
# Example: run before the server starts (exec) inside the entrypoint
src="plugins/redmine_monaco_editor/public_dist/vs"
dest="public/monaco_assets/vs"
if [ -d "$src" ]; then
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    cp -r "$src" "$dest"
fi
```

Because it's wrapped in `if [ -d "$src" ]`, removing this plugin won't affect startup (if the source doesn't exist, it does nothing).

### Non-Docker (Passenger / Puma in place, etc.)

`public/monaco_assets/vs/` persists once copied, so you only need to run Step 2 once. When you update the plugin, run Step 2 again to replace `vs/`.

A symlink works too (if your web server can serve symlink targets).

```bash
ln -s <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist/vs \
      <REDMINE_ROOT>/public/monaco_assets/vs
```

## Uninstall

1. Remove `plugins/redmine_monaco_editor/`
2. Remove `public/monaco_assets/`
3. Restart Redmine

You'll be back to the default editor.

## License

This plugin is released under the MIT License. See [LICENSE](LICENSE) for details.

Note that the Monaco Editor bundled under `public_dist/vs/` is a separate work by Microsoft under its own license (the MIT License). The copyright and license of Monaco Editor belong to Microsoft.
