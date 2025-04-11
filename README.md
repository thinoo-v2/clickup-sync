# Obsidian ClickUp Sync

A plugin for [Obsidian](https://obsidian.md) that synchronizes your Obsidian documents with ClickUp.

## Features

- Sync your Obsidian documents/notes with ClickUp
- Bidirectional synchronization between Obsidian and ClickUp
- Maintain document structure and formatting across platforms
- Automatically convert Obsidian markdown to ClickUp compatible format
- Track document changes and keep everything in sync
- Custom templates for new documents

## Installation

1. Open Obsidian
2. Go to Settings > Community plugins
3. Disable Safe mode
4. Click on "Browse" and search for "ClickUp Sync"
5. Install the plugin
6. Enable the plugin in your list of installed plugins

## Setup

1. Open the plugin settings
2. Enter your ClickUp API key
   - You can obtain your API key from your [ClickUp profile settings](https://app.clickup.com/settings/profile)
3. Configure which ClickUp workspaces, spaces, and folders to sync
4. Select the folders in your Obsidian vault to synchronize
5. Save settings

## Usage

### Syncing Documents

- Click the ClickUp icon in the ribbon to manually sync documents
- Documents will automatically sync based on your sync interval settings
- Changes made in either Obsidian or ClickUp will be synchronized


### Managing Document Sync

You can control document synchronization by:

1. Adding frontmatter to specify sync behavior for individual documents
2. Using the command palette to force sync specific documents
3. Right-clicking on a document in the file explorer to sync

## Troubleshooting

- **Documents not syncing**: Verify your API key and check your network connection
- **Missing documents**: Ensure you've selected the correct folders for synchronization
- **Sync errors**: Check the console (Ctrl+Shift+I) for error messages
- **Formatting issues**: Some complex markdown formatting might not translate perfectly to ClickUp

## Privacy & Security

- Your ClickUp API key is stored locally in your vault
- No data is sent to third-party services
- All communication happens directly between your Obsidian vault and the ClickUp API

## Support

If you encounter any issues or have feature requests, please:

1. Check the [FAQ](https://github.com/your-username/obsidian-clickup-sync/wiki/FAQ)
2. Search existing [issues](https://github.com/your-username/obsidian-clickup-sync/issues)
3. Open a new issue if your problem hasn't been reported

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
