# Obsidian ClickUp Sync Plugin

This plugin allows you to synchronize notes from your Obsidian vault, or a specific folder within it, to pages within a designated ClickUp Document.

## Features

*   **Sync Obsidian Notes to ClickUp:** Keeps your ClickUp Docs updated with content from your Obsidian notes.
*   **Target Specific Folder:** Configure the plugin to only sync notes from a particular folder in your vault.
*   **Create or Update:** Automatically creates new pages in your ClickUp Doc for new notes or updates existing pages if a corresponding note is modified. It maintains a mapping between Obsidian files and ClickUp page IDs.
*   **Manual Sync:** Trigger a sync manually using a ribbon icon or a command palette command ("Sync specific folder to ClickUp Doc Pages").
*   **Automatic Sync:** Optionally enable synchronization automatically whenever a file within the target folder is saved.

## Installation

1.  Download the latest release from the [Releases](https://github.com/your-username/obsidian-clickup-plugin/releases) page (Replace with your actual GitHub repo link).
2.  Extract the plugin folder into your Obsidian vault's `.obsidian/plugins/` directory.
3.  Reload Obsidian (Ctrl+R or Cmd+R).
4.  Go to `Settings` -> `Community plugins`, find "ClickUp Sync Plugin" (or the name you set in `manifest.json`), and enable it.

Alternatively, use the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin to install beta versions directly from the GitHub repository.

## Configuration

After enabling the plugin, you need to configure it in the settings tab:

1.  **ClickUp API Key:** Your personal ClickUp API token. You can generate one in your ClickUp settings under `My Settings` -> `Apps`.
2.  **ClickUp Workspace ID:** The ID of the ClickUp Workspace containing the target document. You can usually find this in the URL when browsing your workspace or via the ClickUp API.
3.  **ClickUp Target Doc ID:** The ID of the specific ClickUp Document where the pages should be created/updated. Find this in the URL of the Doc.
4.  **Obsidian Folder Path:** The path to the folder within your Obsidian vault that you want to sync. Leave blank to sync the entire vault. Example: `Notes/ClickUpSync`.
5.  **Sync on Save:** Toggle this on if you want the plugin to automatically sync a file every time it's saved.

## Usage

*   **Manual Sync:**
    *   Click the "upload-cloud" icon in the left ribbon.
    *   Open the command palette (Ctrl+P or Cmd+P) and search for "Sync specific folder to ClickUp Doc Pages".
*   **Automatic Sync:** If "Sync on Save" is enabled in the settings, files within the specified folder will be synced automatically when saved.

## Building

If you want to build the plugin from the source:

1.  Clone the repository.
2.  Navigate to the repository directory in your terminal.
3.  Install dependencies: `npm install` (or `pnpm install` if you use pnpm).
4.  For development (watches for changes): `npm run dev`
5.  For a production build: `npm run build`

This will generate the `main.js`, `manifest.json`, and `styles.css` files in the project root.

## Author

FIRESTICK.LIVE

## License

[MIT](LICENSE)
