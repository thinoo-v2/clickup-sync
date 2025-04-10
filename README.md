# Obsidian ClickUp Sync Plugin

This plugin syncs between Obsidian Markdown files and ClickUp Doc Pages, allowing for bidirectional integration between these two knowledge management tools.

## Features

- Sync Obsidian markdown files to ClickUp document pages
- Download ClickUp document pages to Obsidian
- Configure multiple sync targets (folder-to-doc mappings)
- Support for hierarchical folder structures 
- Auto-sync on file save
- Preserve folder hierarchy in ClickUp's page structure

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings
2. Go to "Community Plugins" and disable "Safe Mode"
3. Click "Browse" and search for "ClickUp Sync"
4. Install the plugin and enable it

### Manual Installation

1. Download the latest release from the GitHub repository
2. Extract the files to your Obsidian vault's `.obsidian/plugins/obsidian-clickup-sync` folder
3. Reload Obsidian or restart the app
4. Enable the plugin in Obsidian settings

## Configuration

1. Get your ClickUp API key from ClickUp settings > Apps
2. Get your ClickUp Workspace ID from your ClickUp URL (e.g., app.clickup.com/1234567/...)
3. Configure these in the plugin settings
4. Add sync targets (mappings between Obsidian folders and ClickUp Docs)

## Usage

### Sync from Obsidian to ClickUp

1. Configure your sync targets in settings
2. Click the cloud icon in the left ribbon or run the "Sync to ClickUp Doc Pages" command
3. Files in the configured folders will be synced to ClickUp

### Download from ClickUp to Obsidian

1. Go to plugin settings
2. Find your sync target
3. Click "Download ClickUp" to download all pages from that target
4. Optionally specify a parent page ID to only download children of that page

## Development

This plugin uses a modular TypeScript structure:

- `src/main.ts`: Main plugin entry point
- `src/models/`: Data models and interfaces
- `src/api/`: ClickUp API interaction
- `src/views/`: UI components and modals
- `src/utils/`: Utility functions
- `src/core/`: Core sync logic

### Building the plugin

```bash
# Install dependencies
pnpm install

# Development build with watch mode
pnpm run dev

# Production build
pnpm run build

# Clean and build for release
pnpm run release
```

## Project Structure

```
obsidian-clickup-sync/
├── src/                  # Source code
│   ├── api/              # API interactions
│   ├── core/             # Core sync logic
│   ├── models/           # Data models
│   ├── settings/         # Settings UI
│   ├── utils/            # Utility functions
│   ├── views/            # UI components
│   └── main.ts           # Plugin entry point
├── dist/                 # Production build output
├── manifest.json         # Plugin manifest
├── package.json          # Package configuration
├── tsconfig.json         # TypeScript configuration
└── styles.css            # CSS styles
```

## License

MIT License
