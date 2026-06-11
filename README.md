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
Type `@` to bring up project member candidates. Fuzzy matching is supported, and even if you pick by display name it is inserted in the login-ID form (`@login`) that Redmine recognizes, so you can enter mentions accurately and quickly. Hovering over a confirmed mention shows that person's info in a tooltip.

**Formatting toolbar**
Insert bold, italic, underline, strikethrough, inline code, headings (H1–H4), bulleted lists, numbered lists, quotes, and code blocks from buttons. They work both by wrapping a selection and by inserting at the cursor. Keyboard shortcuts `Ctrl+B` (bold) and `Ctrl+I` (italic) are supported as well.

**Table grid insertion**
Click the table button and a grid appears; just pick the rows × columns with your mouse (like "3×4") to insert a table skeleton. You can start building tables with an Excel/Word-like feel.

**Table builder (Excel-like editing)**
Next to the table button, the "table builder" button opens an Excel-like table editor in a separate tab from the body. You can type directly into cells (IME input works from the first character), add/remove rows and columns, select and reorder by dragging, rename columns by double-clicking the header, sort by column, and paste from Excel or Markdown tables. Insert the finished table into the body with the "Insert as Markdown" / "Insert as Textile" buttons. Use the "Body" tab to return to editing, "+" to add tables, and "×" to close them. Multiple tables can be edited in parallel.

The table builder itself is bundled as a standalone JavaScript library called `textgrid` (MIT license) under `public_dist/textgrid/`. You can reuse it outside of this Redmine plugin as a Markdown / Textile compatible spreadsheet UI. See `public_dist/textgrid/README.md` for details.

**Edit existing tables in place**
For tables already written in the body, click the table icon that appears at the left of the first row (next to the line gutter) to load it into the table builder. After editing, press "Update" and the original table is rewritten in place. Markdown stays Markdown and Textile stays Textile, so the syntax is never changed unexpectedly. No more lining up `|` characters by hand.

**Cell and header styling (Textile mode only)**
When the ticket format is Textile, the right-click menu in the table builder offers "Set color", "Make bold", and "Make italic". You can apply them to data cells or column headers, and they affect the whole selection at once. Colors come from an 8-color preset palette (soft red, yellow, green, blue, etc.), and "Custom color" lets you pick any color. Styles are saved using the standard Textile syntax (`|{background:#fee}. text |` / `*bold*` / `_italic_`), so they show up in the Redmine display as expected. Since Markdown has no standard syntax for cell styling, this feature is shown only for Textile tickets.

**Image insertion**
Pick an image attached to the ticket/wiki from a thumbnail list and insert it. Images that were just uploaded but not yet saved also appear as candidates. When duplicate file names exist, the newer one takes precedence, and hovering shows the date.

**Clipboard image paste**
Paste an image from the clipboard (e.g. a screenshot taken with Win+Shift+S) directly into the editor with Ctrl+V. The image is uploaded through Redmine's standard attachment mechanism and the corresponding markup is inserted at the cursor position (`![](filename)` for Markdown, `!{width: ...}.filename!` for Textile). This works only on screens that have an attachment form (ticket description/notes, wiki, etc.); on screens without attachments (project description, the welcome message, etc.) it is intentionally disabled so you never end up with markup pointing at a file that was never uploaded. Note that clipboard *reading* relies on the browser: it works over a native paste event, so unlike the right-click "Paste" menu it does not require clipboard-read permission and works under self-signed certificates.

**Image markup hover thumbnail**
Hover over an image reference in the body and a small thumbnail of that attachment, along with its file name and date, is shown in a tooltip — the same image you would see in the attachment picker.

**File link insertion**
Insert a link to an attachment (`attachment:filename`) by picking it from a list. Each file type — Excel, Word, PDF, PowerPoint, image, code, config file, and more — gets its own icon so you can tell them apart at a glance. Hovering shows the file name, description, and date.

**Macro completion**
Type `{{` to bring up the macros available in your Redmine. In addition to built-in macros like `toc`, `include`, `collapse`, and `thumbnail`, macros added by other plugins (DMSF, drawio, etc.) also appear automatically. Selecting a candidate shows the macro's description on the side, so you won't get stuck on argument syntax. You can also trigger it from the "Insert macro" toolbar button.

**Wiki link completion**
Type `[[` to bring up the wiki pages you can view. Pages in other projects are completed in the `[[project-identifier:page-name]]` form automatically. Wiki pages are also suggested inside the parentheses of macros that take a page name, such as `{{include(` and `{{child_pages(`. You can also trigger it from the "Insert wiki link" toolbar button.

**Thumbnail zoom in preview**
Thumbnails inserted with `{{thumbnail}}` can be clicked in the preview to zoom in place. It does not navigate to the original image page, so you can check the image larger while keeping your work. Close it with a background click, the × button, or the ESC key.

**Markdown and Textile support**
Works whether Redmine is set to Markdown or Textile. The toolbar buttons automatically emit the correct markup for the active format, so you get the same operation feel in either environment.

**Per-user on/off**
For people who prefer the familiar standard editor, each user can choose whether to use Monaco Editor from their own "My account" preferences page. When turned off, Monaco is not loaded for that user and Redmine's standard editor is shown as usual.

**Selectable themes**
Each user can pick an editor theme from their "My account" preferences: GitHub Light, Quiet Light (both light), or GitHub Dark (night mode). The choice is per-user, so everyone can use the look they prefer.

**Adjustable font size**
Each user can also choose the editor font size from their "My account" preferences. Like the other options, it is saved per-user.

**Fullscreen mode**
A fullscreen button sits at the top-right of the editor toolbar. Click it to expand just the editor to fill the whole screen, so you can focus on writing long documents. Press the button again or hit ESC to return to normal.

## Tested environment

- Redmine 6.1 (Propshaft environment)
- Text formatting: both Markdown and Textile are supported (select under "Administration > Settings > General")
- UI language: Japanese and English (follows the Redmine per-user language setting automatically)
- Bundled Monaco Editor: v0.52.0 (shipped with the plugin; works fully offline)

## Directory layout

```
redmine_monaco_editor/
├── init.rb                          # Plugin registration + ViewHook + asset symlink setup
├── app/
│   └── controllers/
│       ├── monaco_macros_controller.rb     # Macro list API (for {{ completion)
│       ├── monaco_wiki_pages_controller.rb # Wiki page list API (for [[ completion)
│       └── monaco_users_controller.rb      # Member list API (for @ completion)
├── config/
│   ├── routes.rb                    # Routes for the APIs above (/monaco_editor/...)
│   └── locales/
│       ├── en.yml                   # UI strings (English)
│       └── ja.yml                   # UI strings (Japanese)
├── assets/
│   ├── javascripts/monaco_editor.js # Main script
│   └── stylesheets/monaco_editor.css
├── public_dist/                    # Plain-path assets (init.rb auto-symlinks to public/monaco_assets)
│   ├── vs/                          # Monaco itself
│   └── textgrid/                    # Table builder library (standalone ESM module)
│       ├── src/                     #   ESM body (import via src/index.js)
│       ├── styles/                  #   CSS (loaded automatically)
│       ├── demo/                    #   Standalone harness for manual testing (optional)
│       ├── test/                    #   jsdom-based tests
│       ├── README.md / README.ja.md
│       └── LICENSE (MIT)
├── LICENSE
└── README.md
```

## Installation

### Step 1: Place the plugin

Put the `redmine_monaco_editor` directory under Redmine's `plugins/`.

```
<REDMINE_ROOT>/plugins/redmine_monaco_editor/
```

### Step 2: Restart Redmine

Restart your web server (Puma / Passenger, etc.).

On startup, the plugin's `init.rb` automatically creates a symlink so that the bundled assets are served with plain paths:

```
<REDMINE_ROOT>/public/monaco_assets -> <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist
```

This means **no manual copy step is required.** Both `vs/` (Monaco) and `textgrid/` (table builder library) become reachable under `/monaco_assets/`. The symlink is created only when `public/monaco_assets` does not already exist, so it is safe to leave in place across restarts.

### Verify

Open a ticket or wiki edit screen in your browser; if the editor has changed to Monaco, it worked. You can also confirm by accessing `<host>/monaco_assets/vs/loader.js` directly and getting a 200 response.

If the editor does not appear, create the symlink manually:

```bash
ln -s <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist \
      <REDMINE_ROOT>/public/monaco_assets
```

If it still does not appear, make sure your web server is allowed to follow symlinks (e.g. nginx's `disable_symlinks` is off).

## Uninstall

1. Remove `plugins/redmine_monaco_editor/`
2. Remove `public/monaco_assets` (the symlink)
3. Restart Redmine

You'll be back to the default editor.

## License

This plugin is released under the MIT License. See [LICENSE](LICENSE) for details.

Note that the Monaco Editor bundled under `public_dist/vs/` is a separate work by Microsoft under its own license (the MIT License). The copyright and license of Monaco Editor belong to Microsoft.
