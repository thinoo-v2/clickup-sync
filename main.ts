import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';

// Define a new interface for a single sync configuration
interface SyncTarget {
	docId: string;
	folderPath: string;
	parentPageId: string | null; // Parent page ID (can be null for top-level pages)
}

// Interface for ClickUp Sync settings
interface ClickUpSyncSettings {
	clickUpApiKey: string;
	clickUpWorkspaceId: string; // ClickUp Workspace ID (assuming one workspace for now)
	syncTargets: SyncTarget[]; // Array of sync configurations
	syncOnSave: boolean; // Option to sync automatically when a file is saved
	pageMapping: Record<string, string>; // Mapping: Obsidian file path -> ClickUp Page ID
}

// Default settings values
const DEFAULT_SETTINGS: ClickUpSyncSettings = {
	clickUpApiKey: '',
	clickUpWorkspaceId: '',
	syncTargets: [], // Initialize as empty array
	syncOnSave: false,
	pageMapping: {}, // Initialize empty mapping
}


// Structure for ClickUp Page (simplified) from API response
interface ClickUpPage {
	id: string;
	name: string;
	// Add other relevant fields if needed
}

// Main Plugin Class
export default class ClickUpSyncPlugin extends Plugin {
	settings: ClickUpSyncSettings;

	async onload() {
		await this.loadSettings();

		// Load mapping initially
		this.settings.pageMapping = (await this.loadData())?.pageMapping || {};

		// --- Settings Tab ---
		this.addSettingTab(new ClickUpSyncSettingTab(this.app, this));

		// --- Ribbon Icon (Optional) ---
		this.addRibbonIcon('upload-cloud', 'Sync to ClickUp Doc Pages', (evt: MouseEvent) => {
			this.syncVaultToClickupDoc();
		});

		// --- Command Palette Command ---
		this.addCommand({
			id: 'sync-obsidian-to-clickup-doc-pages',
			name: 'Sync specific folder to ClickUp Doc Pages',
			callback: () => {
				this.syncVaultToClickupDoc();
			}
		});

		// --- Automatic Sync on Save (if enabled) ---
		this.registerEvent(
			this.app.vault.on('modify', async (file) => { // Make callback async
				if (this.settings.syncOnSave && file instanceof TFile) {
					// Use the new handler function for auto-sync
					await this.handleAutoSync(file);
				}
			})
		);

		console.log('ClickUp Doc Sync Plugin loaded.');
	}

	onunload() {
		console.log('ClickUp Doc Sync Plugin unloaded.');
	}

	async loadSettings() {
		// Load settings, ensuring pageMapping is merged correctly
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		// Ensure pageMapping exists, even if loading old data without it
		this.settings.pageMapping = this.settings.pageMapping || {};
	}

	async saveSettings() {
		// Save settings including the pageMapping
		await this.saveData(this.settings);
	}

	// --- Core Sync Logic ---

	/**
	 * Checks if a file is within any of the configured sync target folders.
	 * Returns the matching SyncTarget or null if none found.
	 */
	findSyncTargetForFile(file: TFile): SyncTarget | null {
		if (!this.settings.syncTargets || this.settings.syncTargets.length === 0) {
			// If no targets are configured, return null indicating no specific target matched
			return null;
		}

		for (const target of this.settings.syncTargets) {
			// Normalize folder path: ensure it ends with '/' if not empty
			const folderPath = target.folderPath.trim();
			const normalizedPath = folderPath === '' || folderPath.endsWith('/')
				? folderPath
				: folderPath + '/';

			// Check if the file path starts with the normalized folder path
			// If folderPath is empty, it matches all files (root)
			if (normalizedPath === '' || file.path.startsWith(normalizedPath)) {
				return target; // Found a matching target
			}
		}

		return null; // No matching target found
	}

	/**
	 * Gets all pages for a specific ClickUp Doc.
	 * Handles potential errors.
	 * @param docId The ID of the ClickUp Doc to fetch pages from.
	 */
	async getClickUpDocPages(docId: string): Promise<ClickUpPage[] | null> {
		const { clickUpApiKey, clickUpWorkspaceId } = this.settings;
		// Using the passed docId instead of a global setting
		if (!clickUpApiKey || !clickUpWorkspaceId) {
			console.warn('ClickUp API Key or Workspace ID not configured.');
			// Can't proceed without these global settings
			new Notice('ClickUp API Key or Workspace ID not configured.');
			return null;
		}
		if (!docId) {
			console.warn('No Doc ID provided to getClickUpDocPages.');
			// Cannot fetch pages without a specific Doc ID
			return null;
		}

		// Use the provided docId in the API URL
		const apiUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages`;

		try {
			const response = await requestUrl({
				method: 'GET',
				url: apiUrl,
				headers: { 'Authorization': clickUpApiKey },
				throw: false,
			});

			if (response.status === 200) {
				// Assuming the response body has a 'pages' array based on typical API design
				// Adjust this based on the actual API response structure if needed
				return response.json.pages || response.json || [];
			} else {
				console.error(`Error fetching ClickUp pages for Doc ${docId}: ${response.status}`, response.json);
				new Notice(`Error fetching pages for Doc ${docId}: ${response.json?.err || 'Unknown error'} (Status: ${response.status})`);
				return null;
			}
		} catch (error) {
			console.error(`Failed to fetch ClickUp pages for Doc ${docId}:`, error);
			new Notice(`Failed to fetch pages for Doc ${docId}. Check console.`);
			return null;
		}
	}

	/**
	 * Syncs a single Obsidian file to a specific ClickUp Doc Page based on the sync target.
	 * Creates a new page or updates an existing one based on mapping or name matching.
	 *
	 * @param file The Obsidian file to sync.
	 * @param syncTarget The specific sync configuration (docId, folderPath) for this file.
	 * @param existingPages Optional: Pre-fetched list of pages for the target ClickUp Doc.
	 * @returns {Promise<boolean>} True if sync was successful, false otherwise.
	 */
	async syncFileToClickupPage(file: TFile, syncTarget: SyncTarget, existingPages?: ClickUpPage[] | null): Promise<boolean> {
		const { clickUpApiKey, clickUpWorkspaceId, pageMapping } = this.settings;
		const { docId } = syncTarget; // Get the target Doc ID from the syncTarget object

		// Removed check for clickUpTargetDocId as we now use docId from syncTarget
		if (!clickUpApiKey || !clickUpWorkspaceId) {
			new Notice('ClickUp API Key or Workspace ID not configured.');
			return false; // Indicate failure
		}
		if (!docId) {
			console.error(`[Sync Error] Sync target for folder "${syncTarget.folderPath}" is missing a Doc ID.`);
			new Notice(`Sync target configuration error for folder ${syncTarget.folderPath}.`);
			return false;
		}


		let fileContent: string;
		try {
			fileContent = await this.app.vault.cachedRead(file);
			// Limit logging length for large files
			console.log(`[Sync Debug] File: ${file.path}, Content Length: ${fileContent.length}, Target Doc: ${docId}`);
		} catch (readError) {
			console.error(`[Sync Error] Failed to read file: ${file.path}`, readError);
			new Notice(`Failed to read file ${file.basename}. Cannot sync.`);
			return false;
		}

		const fileName = file.basename;
		// Generate a unique key for the mapping based on file path AND target doc ID
		// This prevents conflicts if the same file name exists under different sync targets
		const mappingKey = `${docId}:::${file.path}`;
		let targetPageId: string | null = pageMapping[mappingKey] || null; // Check mapping first

		// If not in mapping, try to find by name in existing pages for THIS doc
		if (!targetPageId && existingPages) {
			const foundPage = existingPages.find(page => page.name === fileName);
			if (foundPage) {
				targetPageId = foundPage.id;
				this.settings.pageMapping[mappingKey] = targetPageId; // Use the unique key
				console.log(`Mapped existing page '${fileName}' (ID: ${targetPageId}) in Doc ${docId} to file ${file.path}`);
				// Save settings immediately when a mapping is added by discovery
				await this.saveSettings();
			}
		}

		let response;
		let success = false;
		let requestBody: Record<string, any>;
		let responseJson: any = null; // Variable to hold parsed JSON safely

		try {
			if (targetPageId) {
				// --- Update Existing Page ---
				console.log(`Updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId} for file: ${file.path}`);
				// Use the docId from syncTarget in the URL
				const updateUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${targetPageId}`;
				requestBody = {
					name: fileName,
					content: fileContent,
					content_format: 'text/md',
				};
				// console.log(`[Sync Debug] PUT Request Body to ${updateUrl}:`, JSON.stringify(requestBody).substring(0, 500) + '...');

				response = await requestUrl({
					method: 'PUT',
					url: updateUrl,
					headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody),
					throw: false, // Important: Prevent throwing on non-2xx codes
				});

				// console.log(`[Sync Debug] PUT Response Status: ${response.status}`);
				// --- Safely attempt to parse JSON ---
				try {
					// Only parse if response text exists and content type suggests JSON
					if (response.text && response.headers['content-type']?.includes('application/json')) {
						responseJson = JSON.parse(response.text); // Parse from text to avoid Obsidian's auto-parsing issues
						// console.log(`[Sync Debug] PUT Response Body Parsed:`, responseJson);
					} else {
						// console.log(`[Sync Debug] PUT Response Body (Non-JSON or Empty):`, response.text?.substring(0, 500));
					}
				} catch (parseError) {
					console.error(`[Sync Error] Failed to parse PUT response body for page ${targetPageId} in Doc ${docId}:`, parseError);
					console.log(`[Sync Debug] PUT Raw Response Text:`, response.text);
					if(!(response.status >= 200 && response.status < 300)) {
						new Notice(`Sync error: Invalid response from ClickUp (PUT). Status: ${response.status}`);
					}
				}

				// --- Check status code for success ---
				// Accept 200 OK or 204 No Content as success for PUT
				if (response.status === 200 || response.status === 204) {
					console.log(`Successfully updated page '${fileName}' in ClickUp Doc ${docId} (Status: ${response.status}).`);
					success = true;
				} else {
					console.error(`Error updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId}: Status ${response.status}`, responseJson || response.text);
					new Notice(`Error updating page ${fileName} in Doc ${docId}: ${responseJson?.err || 'Update error'} (Status: ${response.status})`);
				}

			} else {
				// --- Create New Page ---
				console.log(`Creating new page for file: ${file.path} in Doc ${docId}`);
				// Use the docId from syncTarget in the URL
				const createUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages`;
				requestBody = {
					name: fileName,
					content: fileContent,
					content_format: 'text/md',
				};
				
				// Add parent_page_id to request body if it exists
				if (syncTarget.parentPageId) {
					requestBody.parent_page_id = syncTarget.parentPageId;
				}
				
				// console.log(`[Sync Debug] POST Request Body to ${createUrl}:`, JSON.stringify(requestBody).substring(0, 500) + '...');

				response = await requestUrl({
					method: 'POST',
					url: createUrl,
					headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody),
					throw: false,
				});

				// console.log(`[Sync Debug] POST Response Status: ${response.status}`);
				// --- Safely attempt to parse JSON ---
				try {
					if (response.text && response.headers['content-type']?.includes('application/json')) {
						responseJson = JSON.parse(response.text);
						// console.log(`[Sync Debug] POST Response Body Parsed:`, responseJson);
					} else {
						// console.log(`[Sync Debug] POST Response Body (Non-JSON or Empty):`, response.text?.substring(0, 500));
					}
				} catch (parseError) {
					console.error(`[Sync Error] Failed to parse POST response body for page creation in Doc ${docId}:`, parseError);
					console.log(`[Sync Debug] POST Raw Response Text:`, response.text);
					new Notice(`Sync error: Invalid response from ClickUp (POST). Status: ${response.status}`);
					 // Fail if parsing fails and status is not success
					if(!(response.status >= 200 && response.status < 300)) {
						// Let the status check below handle the Notice
					} else {
						 // If status was 2xx but parsing failed, maybe still log error but don't stop mapping?
						 console.error(`[Sync Warning] Page for ${fileName} in Doc ${docId} might have been created (Status ${response.status}), but response parsing failed.`);
					}
				}

				// --- Check status code AND response body for success ---
				// Expecting 200 or 201 Created with an ID in the body
				if ((response.status === 200 || response.status === 201) && responseJson?.id) {
					const newPageId = responseJson.id;
					this.settings.pageMapping[mappingKey] = newPageId; // Use the unique key
					console.log(`Successfully created page '${fileName}' (ID: ${newPageId}) in ClickUp Doc ${docId}.`);
					success = true;
					// Save mapping immediately when a page is created
					await this.saveSettings();
				} else {
					console.error(`Error creating page for '${fileName}' in Doc ${docId}: Status ${response.status}`, responseJson || response.text);
					new Notice(`Error creating page ${fileName} in Doc ${docId}: ${responseJson?.err || 'Create error'} (Status: ${response.status})`);
				}
			}

			// Mapping is now saved immediately upon creation or discovery

		} catch (error) {
			// Catch errors from requestUrl itself (network issues, etc.)
			console.error(`[Sync Error] Failed to sync file ${file.path} to ClickUp page in Doc ${docId}:`, error);
			new Notice(`Failed to sync ${file.basename}. Check console.`);
			success = false; // Ensure success is false on general error
		}
		return success; // Return success status
	}

	/**
	 * Syncs markdown files based on configured sync targets.
	 * Iterates through each target, finds matching files, and syncs them.
	 */
	async syncVaultToClickupDoc() {
		const { clickUpApiKey, clickUpWorkspaceId, syncTargets } = this.settings;
		if (!clickUpApiKey || !clickUpWorkspaceId) {
			new Notice('ClickUp API Key or Workspace ID not configured.');
			return;
		}
		if (!syncTargets || syncTargets.length === 0) {
			new Notice('No sync targets configured in settings.');
			return;
		}

		new Notice(`Starting ClickUp Doc sync for ${syncTargets.length} target(s)...`);
		console.log(`Starting ClickUp Doc sync for ${syncTargets.length} target(s)...`);

		let totalSuccessCount = 0;
		let totalErrorCount = 0;
		const allMdFiles = this.app.vault.getMarkdownFiles(); // Get all files once

		// --- Process each sync target ---
		for (const target of syncTargets) {
			const { docId, folderPath } = target;
			if (!docId) {
				console.warn(`Skipping sync target for folder "${folderPath}" due to missing Doc ID.`);
				new Notice(`Skipping sync target for folder "${folderPath}" (missing Doc ID).`);
				continue; // Skip this target if Doc ID is missing
			}

			console.log(`\n--- Syncing Target: Folder "${folderPath || '(Vault Root)'}" -> Doc ID "${docId}" ---`);
			new Notice(`Syncing folder "${folderPath || '(Vault Root)'}" to Doc ${docId}...`);


			// 1. Get existing pages from ClickUp for THIS target doc
			const existingPages = await this.getClickUpDocPages(docId);
			if (existingPages === null) {
				new Notice(`Failed to get page list for Doc ${docId}. Skipping this target.`);
				console.error(`Failed to get page list for Doc ${docId}. Aborting sync for this target.`);
				totalErrorCount++; // Count failure to get pages as an error for the target
				continue; // Move to the next target
			}
			console.log(`Found ${existingPages.length} existing pages in ClickUp Doc ${docId}.`);

			// 2. Filter Obsidian files relevant to THIS target folder
			const filesToSyncForTarget = allMdFiles.filter(file => {
				const normalizedPath = folderPath === '' || folderPath.endsWith('/') 
					? folderPath 
					: folderPath + '/';
				
				if (normalizedPath === '') {
					return true; // Match all files if folder path is empty (root)
				}
				return file.path.startsWith(normalizedPath);
			});


			if (filesToSyncForTarget.length === 0) {
				console.log(`No specific markdown files found for sync target "${folderPath || '(Vault Root)'}".`);
				// No Notice needed here, it's not an error
				continue; // Move to the next target
			}

			console.log(`Found ${filesToSyncForTarget.length} Obsidian files to sync for target "${folderPath || '(Vault Root)'}". Processing...`);

			let targetSuccessCount = 0;
			let targetErrorCount = 0;

			// 3. Process each file for THIS target
			for (const file of filesToSyncForTarget) {
				// Pass the current target and its fetched pages
				const success = await this.syncFileToClickupPage(file, target, existingPages);
				if (success) {
					targetSuccessCount++;
				} else {
					targetErrorCount++;
				}
				// Optional delay: await sleep(100);
			}

			console.log(`--- Target "${folderPath || '(Vault Root)'}" Sync Complete: Synced: ${targetSuccessCount}, Failed: ${targetErrorCount} ---`);
			totalSuccessCount += targetSuccessCount;
			totalErrorCount += targetErrorCount;
		} // End loop through syncTargets

		// Mapping is saved within syncFileToClickupPage upon creation/discovery

		new Notice(`ClickUp Doc Sync finished. Total Synced: ${totalSuccessCount}, Total Failed: ${totalErrorCount}.`);
		console.log(`\n=== ClickUp Doc Sync Overall Complete. Total Synced: ${totalSuccessCount}, Total Failed: ${totalErrorCount} ===`);

		// Optional: Run cleanup after all syncs are done
		// await this.cleanupPageMapping();
	}

	/**
	 * Handles auto-sync when a file is modified (called from the 'modify' event listener if syncOnSave is true)
	 */
	async handleAutoSync(file: TFile) {
		if (!(file instanceof TFile)) return; // Ensure it's a file

		// Find the specific sync target for this modified file
		const syncTarget = this.findSyncTargetForFile(file);

		if (syncTarget) {
			console.log(`Auto-syncing modified file: ${file.path} to Doc ID: ${syncTarget.docId}`);
			// We need the existing pages for potential name matching if the mapping doesn't exist yet
			const existingPages = await this.getClickUpDocPages(syncTarget.docId);
			if (existingPages === null) {
				console.error(`Auto-sync failed: Could not fetch pages for Doc ${syncTarget.docId}`);
				new Notice(`Auto-sync failed for ${file.basename}: Could not fetch ClickUp pages.`);
				return;
			}
			await this.syncFileToClickupPage(file, syncTarget, existingPages);
		} else {
			// File not in any configured sync target - silently ignore
		}
	}

	/**
	 * Removes entries from the mapping if the corresponding Obsidian file no longer exists
	 * or if the sync target associated with the mapping key is removed.
	 * The mapping key format is `${docId}:::${filePath}`.
	 */
	async cleanupPageMapping() {
		console.log("Cleaning up page mapping...");
		let changed = false;
		const allMdFilesPaths = new Set(this.app.vault.getMarkdownFiles().map(f => f.path));
		const validDocIds = new Set(this.settings.syncTargets.map(t => t.docId));

		for (const mappingKey in this.settings.pageMapping) {
			const parts = mappingKey.split(':::');
			if (parts.length !== 2) {
				console.warn(`Invalid mapping key format found: ${mappingKey}. Removing.`);
				delete this.settings.pageMapping[mappingKey];
				changed = true;
				continue;
			}
			const [docId, obsidianPath] = parts;

			// Check 1: Does the corresponding file still exist?
			const fileExists = allMdFilesPaths.has(obsidianPath);
			// Check 2: Is the docId still part of a valid, configured sync target?
			const docIdIsValid = validDocIds.has(docId);

			if (!fileExists || !docIdIsValid) {
				if (!fileExists) {
					console.log(`Removing mapping for deleted/moved file: ${obsidianPath} (Doc: ${docId}, Page ID: ${this.settings.pageMapping[mappingKey]})`);
				}
				if (!docIdIsValid) {
					console.log(`Removing mapping for removed/invalid Doc ID: ${docId} (File: ${obsidianPath}, Page ID: ${this.settings.pageMapping[mappingKey]})`);
				}
				delete this.settings.pageMapping[mappingKey];
				changed = true;
			}
		}

		if (changed) {
			await this.saveSettings();
			console.log("Page mapping cleanup complete.");
		} else {
			console.log("No stale entries found in page mapping.");
		}
	}
}

// --- Settings Tab Class ---
class ClickUpSyncSettingTab extends PluginSettingTab {
	plugin: ClickUpSyncPlugin;

	constructor(app: App, plugin: ClickUpSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'ClickUp Doc Sync Settings' });

		// --- Global Settings ---
		containerEl.createEl('h3', { text: 'API Configuration' });
		new Setting(containerEl)
			.setName('ClickUp API Key')
			.setDesc('Your personal ClickUp API Key (pk_xxxxxxx). Found in ClickUp settings under "Apps".')
			.addText(text => text
				.setPlaceholder('pk_xxxxxxx')
				.setValue(this.plugin.settings.clickUpApiKey)
				.onChange(async (value) => {
					this.plugin.settings.clickUpApiKey = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('ClickUp Workspace ID')
			.setDesc('The ID of the ClickUp Workspace. Find it in your ClickUp URL (e.g., app.clickup.com/1234567/...).')
			.addText(text => text
				.setPlaceholder('1234567')
				.setValue(this.plugin.settings.clickUpWorkspaceId)
				.onChange(async (value) => {
					this.plugin.settings.clickUpWorkspaceId = value.trim();
					await this.plugin.saveSettings();
				}));

		// --- Sync Targets Management ---
		containerEl.createEl('h3', { text: 'Sync Targets (Folder to Doc Mapping)' });
		containerEl.createEl('p', { text: 'Configure which Obsidian folders sync to which ClickUp Docs.' });

		// Display existing sync targets
		this.plugin.settings.syncTargets.forEach((target, index) => {
			const settingItem = new Setting(containerEl)
				.setName(`Target ${index + 1}`)
				.setDesc(`Syncs Obsidian folder "${target.folderPath || '(Vault Root)'}" to ClickUp Doc ID "${target.docId || 'Not Set'}"${target.parentPageId ? ` with parent page ID "${target.parentPageId}"` : ''}.`);

			// Edit Folder Path
			settingItem.addText(text => text
				.setPlaceholder('Obsidian Folder Path (leave empty for root)')
				.setValue(target.folderPath)
				.onChange(async (value) => {
					target.folderPath = value.trim().replace(/^\/+|\/+$/g, ''); // Normalize path
					await this.plugin.saveSettings();
					// Update the description to reflect changes immediately
					settingItem.setDesc(`Syncs Obsidian folder "${target.folderPath || '(Vault Root)'}" to ClickUp Doc ID "${target.docId || 'Not Set'}"${target.parentPageId ? ` with parent page ID "${target.parentPageId}"` : ''}.`);
				}));

			// Edit Doc ID
			settingItem.addText(text => text
				.setPlaceholder('ClickUp Target Doc ID (abcde-12345)')
				.setValue(target.docId)
				.onChange(async (value) => {
					target.docId = value.trim();
					await this.plugin.saveSettings();
					settingItem.setDesc(`Syncs Obsidian folder "${target.folderPath || '(Vault Root)'}" to ClickUp Doc ID "${target.docId || 'Not Set'}"${target.parentPageId ? ` with parent page ID "${target.parentPageId}"` : ''}.`);
				}));

			// Edit Parent Page ID
			settingItem.addText(text => text
				.setPlaceholder('Parent Page ID (optional)')
				.setValue(target.parentPageId || '')
				.onChange(async (value) => {
					target.parentPageId = value.trim() || null; // Store as null if empty
					await this.plugin.saveSettings();
					settingItem.setDesc(`Syncs Obsidian folder "${target.folderPath || '(Vault Root)'}" to ClickUp Doc ID "${target.docId || 'Not Set'}"${target.parentPageId ? ` with parent page ID "${target.parentPageId}"` : ''}.`);
				}));

			// Remove Button
			settingItem.addButton(button => button
				.setButtonText('Remove')
				.setWarning() // Make it look deletable
				.onClick(async () => {
					this.plugin.settings.syncTargets.splice(index, 1); // Remove from array
					await this.plugin.saveSettings();
					this.display(); // Redraw the settings tab to reflect removal
					new Notice('Sync target removed.');
				}));
		});

		// Add New Sync Target Button
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add New Sync Target')
				.setCta() // Call To Action style
				.onClick(async () => {
					this.plugin.settings.syncTargets.push({ docId: '', folderPath: '', parentPageId: null }); // Add empty target
					await this.plugin.saveSettings();
					this.display(); // Redraw to show the new empty target fields
					new Notice('New sync target added. Please configure it.');
				}));


		// --- Other Settings ---
		containerEl.createEl('h3', { text: 'Other Options' });
		new Setting(containerEl)
			.setName('Sync on Save')
			.setDesc('Automatically sync a file to its corresponding ClickUp page when saved (if it belongs to a configured sync target).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnSave)
				.onChange(async (value) => {
					this.plugin.settings.syncOnSave = value;
					await this.plugin.saveSettings();
				}));

		// --- Mapping Info / Cleanup ---
		containerEl.createEl('h3', { text: 'Sync Mapping Info & Maintenance' });
		const mappingCount = Object.keys(this.plugin.settings.pageMapping).length;
		containerEl.createEl('p', { text: `Currently tracking ${mappingCount} file-to-page mappings across all sync targets.` });
		const cleanupButton = containerEl.createEl('button', { text: 'Clean Up Stale Mappings' });
		cleanupButton.onclick = async () => {
			new Notice('Starting mapping cleanup...');
			await this.plugin.cleanupPageMapping();
			new Notice('Mapping cleanup finished.');
			// Redraw to update mapping count
			this.display();
		};
	}
}
