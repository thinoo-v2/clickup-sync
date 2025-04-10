import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';

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
	parent_id?: string | null; // ID of the parent page, can be undefined, null or string
	// Add other relevant fields if needed
}

// Structure for ClickUp Page with hierarchy information
interface ClickUpPageNode extends ClickUpPage {
	parent_id: string | null;
	children: ClickUpPageNode[];
	pages?: ClickUpPageNode[]; // Add pages field which may be used instead of children
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

		// Add command to fetch and display page tree structure
		this.addCommand({
			id: 'fetch-clickup-page-tree',
			name: 'Fetch ClickUp Doc Page Tree',
			callback: async () => {
				// Simple prompt to get the Doc ID
				const result = await this.promptForDocId();
				if (!result) return;

				const { docId, folderPath } = result;
				
				new Notice(`Fetching page tree for Doc ID: ${docId}...`);
				const pageTree = await this.getClickUpDocPagesTree(docId);
				
				if (pageTree) {
					// Create and open a new leaf with the page tree visualization
					this.displayPageTreeInModal(pageTree, docId);
					
					// If folder path was provided, create or update sync target
					if (folderPath !== undefined) {
						// Check if this target already exists
						const existingTargetIndex = this.settings.syncTargets.findIndex(
							target => target.docId === docId && target.folderPath === folderPath
						);
						
						if (existingTargetIndex >= 0) {
							new Notice(`Sync target already exists for Doc ID: ${docId} and folder: ${folderPath || '(Vault Root)'}`);
						} else {
							// Add new sync target
							this.settings.syncTargets.push({
								docId: docId,
								folderPath: folderPath,
								parentPageId: null
							});
							await this.saveSettings();
							new Notice(`Added new sync target: ${folderPath || '(Vault Root)'} → ${docId}`);
						}
					}
				}
			}
		});

		// Add command to sync child pages from a specific parent page ID
		this.addCommand({
			id: 'sync-clickup-child-pages',
			name: 'Sync child pages from ClickUp to Obsidian',
			callback: async () => {
				// Prompt for Doc ID, folder path, and parent page ID
				const result = await this.promptForSyncParams();
				if (!result) return;

				const { docId, folderPath, parentPageId } = result;
				
				if (!docId || !parentPageId) {
					new Notice('Doc ID and Parent Page ID are required');
					return;
				}
				
				// Create temporary sync target
				const syncTarget: SyncTarget = {
					docId: docId,
					folderPath: folderPath,
					parentPageId: null
				};
				
				// Execute the sync with the parent page ID filter
				new Notice(`Starting sync of child pages from parent ID: ${parentPageId}...`);
				await this.syncClickUpToVault(syncTarget, parentPageId);
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
	 * Gets all pages for a specific ClickUp Doc and organizes them in a tree structure.
	 * Handles potential errors.
	 * @param docId The ID of the ClickUp Doc to fetch pages from.
	 */
	async getClickUpDocPagesTree(docId: string): Promise<ClickUpPageNode[] | null> {
		// First, get all pages using existing method
		const pages = await this.getClickUpDocPages(docId);
		
		if (!pages) {
			return null; // Error already handled in getClickUpDocPages
		}
		
		// Convert flat pages list to tree structure
		const pageMap = new Map<string, ClickUpPageNode>();
		const rootNodes: ClickUpPageNode[] = [];
		
		// First pass: create all nodes with empty children arrays
		pages.forEach(page => {
			const pageNode: ClickUpPageNode = {
				...page,
				parent_id: page.parent_id || null,
				children: [],
			};
			pageMap.set(page.id, pageNode);
		});
		
		// Second pass: build the tree by adding children to their parents
		
		pageMap.forEach(page => {
			if (page.parent_id && pageMap.has(page.parent_id)) {
				// If it has a parent, add it to the parent's children
				const parentNode = pageMap.get(page.parent_id);
				if (parentNode) {
					parentNode.children.push(page);
					// Also add to pages array for compatibility
					if (parentNode.pages) {
						parentNode.pages.push(page);
					} else {
						parentNode.pages = [page];
					}
				}
			} else {
				// No parent or parent not found, it's a root node
				rootNodes.push(page);
			}
		});
		
		console.log(`Built page tree: ${rootNodes.length} root pages, ${pages.length} total pages`);
		return rootNodes;
	}

	/**
	 * Recursively finds a page in the tree by its name
	 * @param name Page name to search for
	 * @param pages Array of pages to search through
	 * @returns The found page or null if not found
	 */
	findPageByNameInTree(name: string, pages: ClickUpPageNode[]): ClickUpPageNode | null {
		for (const page of pages) {
			if (page.name === name) {
				return page;
			}
			
			// Search in children array
			if (page.children && page.children.length > 0) {
				const foundInChildren = this.findPageByNameInTree(name, page.children);
				if (foundInChildren) {
					return foundInChildren;
				}
			}
			
			// Also search in pages array if it exists (API may use this instead of children)
			if (page.pages && page.pages.length > 0 && 
				// Avoid duplicate search if pages is the same as children
				JSON.stringify(page.pages) !== JSON.stringify(page.children)) {
				const foundInPages = this.findPageByNameInTree(name, page.pages);
				if (foundInPages) {
					return foundInPages;
				}
			}
		}
		
		return null;
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
			// --- First attempt to update if we have a targetPageId ---
			if (targetPageId) {
				console.log(`Updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId} for file: ${file.path}`);
				// Use the docId from syncTarget in the URL
				const updateUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${targetPageId}`;
				requestBody = {
					name: fileName,
					content: fileContent,
					content_format: 'text/md',
				};

				response = await requestUrl({
					method: 'PUT',
					url: updateUrl,
					headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody),
					throw: false, // Important: Prevent throwing on non-2xx codes
				});

				// --- Safely attempt to parse JSON ---
				try {
					// Only parse if response text exists and content type suggests JSON
					if (response.text && response.headers['content-type']?.includes('application/json')) {
						responseJson = JSON.parse(response.text); // Parse from text to avoid Obsidian's auto-parsing issues
					}
				} catch (parseError) {
					console.error(`[Sync Error] Failed to parse PUT response body for page ${targetPageId} in Doc ${docId}:`, parseError);
					console.log(`[Sync Debug] PUT Raw Response Text:`, response.text);
				}

				// --- Check status code for success ---
				// Accept 200 OK or 204 No Content as success for PUT
				if (response.status === 200 || response.status === 204) {
					console.log(`Successfully updated page '${fileName}' in ClickUp Doc ${docId} (Status: ${response.status}).`);
					success = true;
					return success; // Early return on successful update
				} else {
					// Log the error but don't return yet - we'll try creating a new page
					console.warn(`Error updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId}: Status ${response.status}. Will attempt to create a new page instead.`, responseJson || response.text);
					new Notice(`Could not update page ${fileName}. Attempting to create new page instead...`);
					
					// Remove the invalid mapping if we couldn't update the page (it might have been deleted in ClickUp)
					delete this.settings.pageMapping[mappingKey];
					targetPageId = null; // Reset targetPageId to force creation of a new page
					await this.saveSettings(); // Save the mapping changes
				}
			}

			// --- Create New Page (either initially or after failed update) ---
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

			response = await requestUrl({
				method: 'POST',
				url: createUrl,
				headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				throw: false,
			});

			// --- Safely attempt to parse JSON ---
			try {
				if (response.text && response.headers['content-type']?.includes('application/json')) {
					responseJson = JSON.parse(response.text);
				}
			} catch (parseError) {
				console.error(`[Sync Error] Failed to parse POST response body for page creation in Doc ${docId}:`, parseError);
				console.log(`[Sync Debug] POST Raw Response Text:`, response.text);
				if(!(response.status >= 200 && response.status < 300)) {
					new Notice(`Sync error: Invalid response from ClickUp (POST). Status: ${response.status}`);
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


			// 1. Get existing pages from ClickUp for THIS target doc as a tree
			const existingPagesTree = await this.getClickUpDocPagesTree(docId);
			if (existingPagesTree === null) {
				new Notice(`Failed to get page tree for Doc ${docId}. Skipping this target.`);
				console.error(`Failed to get page tree for Doc ${docId}. Aborting sync for this target.`);
				totalErrorCount++; // Count failure to get pages as an error for the target
				continue; // Move to the next target
			}
			console.log(`Found page tree for ClickUp Doc ${docId}.`);

			// Also get flat list of pages for backward compatibility
			const existingPages = await this.getClickUpDocPages(docId);
			if (existingPages === null) {
				new Notice(`Failed to get flat page list for Doc ${docId}. Skipping this target.`);
				console.error(`Failed to get flat page list for Doc ${docId}. Aborting sync for this target.`);
				totalErrorCount++;
				continue;
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
				// Try to find parent-child relationship based on folder structure
				let parentId = target.parentPageId;

				// If the file is in a subfolder, try to sync with the folder structure
				const relativePath = folderPath ? file.path.substring(folderPath.length).replace(/^\/+/, '') : file.path;
				const pathParts = relativePath.split('/');
				
				// If file is in a subfolder, attempt to use the folder structure to determine parent
				if (pathParts.length > 1) {
					let currentParentId = target.parentPageId;
					
					// For each directory level (except the last which is the file itself)
					for (let i = 0; i < pathParts.length - 1; i++) {
						const folderName = pathParts[i];
						
						// Try to find a page with this folder name to use as parent
						// First in the flat list for backward compatibility
						let folderPage = existingPages.find(page => page.name === folderName);
						
						// If not found in flat list, try using the tree search
						if (!folderPage) {
							const foundInTree = this.findPageByNameInTree(folderName, existingPagesTree);
							if (foundInTree) {
								folderPage = foundInTree;
							}
						}
						
						if (folderPage) {
							currentParentId = folderPage.id;
							console.log(`Found parent page for folder "${folderName}": ${currentParentId}`);
						} else {
							// Could create folder pages here if needed in the future
							console.log(`No page found for folder "${folderName}". Using last known parent.`);
						}
					}
					
					// Use the last determined parent
					parentId = currentParentId;
				}
				
				// Create a modified target with potentially updated parentPageId
				const modifiedTarget = {
					...target,
					parentPageId: parentId
				};
				
				// Pass the modified target and both tree and flat page lists
				const success = await this.syncFileToClickupPage(file, modifiedTarget, existingPages);
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
			
			// Get both tree and flat list for better mapping
			const existingPagesTree = await this.getClickUpDocPagesTree(syncTarget.docId);
			
			// We need the existing pages for potential name matching if the mapping doesn't exist yet
			const existingPages = await this.getClickUpDocPages(syncTarget.docId);
			if (existingPages === null) {
				console.error(`Auto-sync failed: Could not fetch pages for Doc ${syncTarget.docId}`);
				new Notice(`Auto-sync failed for ${file.basename}: Could not fetch ClickUp pages.`);
				return;
			}
			
			// Try to find parent-child relationship based on folder structure
			let parentId = syncTarget.parentPageId;
			const folderPath = syncTarget.folderPath;

			// If the file is in a subfolder, try to sync with the folder structure
			const relativePath = folderPath ? file.path.substring(folderPath.length).replace(/^\/+/, '') : file.path;
			const pathParts = relativePath.split('/');
			
			// If file is in a subfolder, attempt to use the folder structure to determine parent
			if (pathParts.length > 1 && existingPagesTree) {
				let currentParentId = syncTarget.parentPageId;
				
				// For each directory level (except the last which is the file itself)
				for (let i = 0; i < pathParts.length - 1; i++) {
					const folderName = pathParts[i];
					
					// Try to find a page with this folder name to use as parent
					// First in the flat list for backward compatibility
					let folderPage = existingPages.find(page => page.name === folderName);
					
					// If not found in flat list, try using the tree search
					if (!folderPage && existingPagesTree) {
						const foundInTree = this.findPageByNameInTree(folderName, existingPagesTree);
						if (foundInTree) {
							folderPage = foundInTree;
						}
					}
					
					if (folderPage) {
						currentParentId = folderPage.id;
						console.log(`Found parent page for folder "${folderName}": ${currentParentId}`);
					} else {
						// Could create folder pages here if needed in the future
						console.log(`No page found for folder "${folderName}". Using last known parent.`);
					}
				}
				
				// Use the last determined parent
				parentId = currentParentId;
			}
			
			// Create a modified target with potentially updated parentPageId
			const modifiedTarget = {
				...syncTarget,
				parentPageId: parentId
			};
			
			await this.syncFileToClickupPage(file, modifiedTarget, existingPages);
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

	/**
	 * Helper method to prompt the user for a Doc ID and folder path
	 */
	async promptForDocId(): Promise<{docId: string, folderPath: string} | null> {
		// Create and open a modal for input instead of using prompt()
		return new Promise((resolve) => {
			const modal = new DocIdInputModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
	}
	
	/**
	 * Displays the page tree in a modal for visualization
	 */
	displayPageTreeInModal(pageTree: ClickUpPageNode[], docId: string) {
		const modal = new PageTreeModal(this.app, docId, pageTree, this);
		modal.open();
	}

	/**
	 * Syncs pages from ClickUp to Obsidian, creating/updating files to match the ClickUp structure
	 * @param target The sync target containing docId and folderPath
	 */
	async syncClickUpToVault(target: SyncTarget, parentPageId?: string) {
		const { clickUpApiKey, clickUpWorkspaceId } = this.settings;
		const { docId, folderPath } = target;
		
		if (!clickUpApiKey || !clickUpWorkspaceId) {
			new Notice('ClickUp API Key or Workspace ID not configured.');
			return;
		}
		
		if (!docId) {
			new Notice('Sync target missing Doc ID.');
			return;
		}
		
		console.log(`Starting download from ClickUp Doc ${docId} to folder ${folderPath || '(Vault Root)'}`);
		if (parentPageId) {
			console.log(`Filtering to only include children of parent page ID: ${parentPageId}`);
		}
		
		// 1. Get the page tree from ClickUp
		const pageTree = await this.getClickUpDocPagesTree(docId);
		if (!pageTree) {
			new Notice(`Failed to fetch page tree for Doc ${docId}.`);
			return;
		}

		
		
		console.log(`Found ${pageTree.length} root pages in ClickUp Doc ${docId}. Starting download...`);
		console.log(pageTree);
		
		// 2. Prepare base folder path
		const basePath = folderPath ? (folderPath.endsWith('/') ? folderPath : folderPath + '/') : '';
		
		// 3. Process all pages in the tree
		let successCount = 0;
		let errorCount = 0;
		
		// 4. For tracking duplicate file names
		const processedFileNames = new Set<string>();
		
		try {
			// If parentPageId is specified, find only that parent's children
			if (parentPageId) {
				// Function to find a page by ID in the tree
				const findPageById = (pages: ClickUpPageNode[], id: string): ClickUpPageNode | null => {
					for (const page of pages) {
						if (page.id === id) {
							return page;
						}
						if (page.pages && page.pages.length > 0) {
							const found = findPageById(page.pages, id);
							if (found) return found;
						}
					}
					return null;
				};
				
				// Find the parent page in the tree
				const parentPage = findPageById(pageTree, parentPageId);
				
				if (!parentPage) {
					new Notice(`Parent page with ID ${parentPageId} not found in Doc ${docId}.`);
					console.error(`Parent page with ID ${parentPageId} not found in page tree.`);
					return;
				}
				
				if (!parentPage.pages || parentPage.pages.length === 0) {
					new Notice(`No child pages found for parent page ${parentPage.name}.`);
					console.log(`No child pages found for parent page ${parentPage.name} (ID: ${parentPageId}).`);
					return;
				}


				
				console.log(`Found parent page ${parentPage.name} with ${parentPage.pages.length}  ${parentPage.children.length} children. Processing only these children.`);
				
				// Process only the children of the specified parent
				for (const childPage of parentPage.pages) {
					const results = await this.processClickUpPageForDownload(
						childPage,
						docId,
						basePath,
						'',
						processedFileNames
					);
					successCount += results.success;
					errorCount += results.error;
				}
			} else {
				// Original behavior: process all root pages
				for (const rootPage of pageTree) {
					const results = await this.processClickUpPageForDownload(
						rootPage, 
						docId,
						basePath, 
						'', 
						processedFileNames
					);
					successCount += results.success;
					errorCount += results.error;
				}
			}
			
			// Show completion notice
			new Notice(`ClickUp sync down complete! Created/updated ${successCount} files, ${errorCount} errors.`);
			console.log(`ClickUp Sync Down Complete: Created/updated ${successCount} files, encountered ${errorCount} errors.`);
			
		} catch (error) {
			console.error('Error during ClickUp-to-Obsidian sync:', error);
			new Notice('Error during sync from ClickUp. Check console.');
		}
	}

	/**
	 * Processes a ClickUp page and its children for download to Obsidian
	 * @param page The ClickUp page to process
	 * @param docId The ClickUp Doc ID that contains this page
	 * @param basePath The base folder path in Obsidian
	 * @param currentPath The current subfolder path
	 * @param processedFileNames Set of already processed file names to avoid duplicates
	 * @returns Count of successfully processed pages and errors
	 */
	async processClickUpPageForDownload(
		page: ClickUpPageNode,
		docId: string,
		basePath: string,
		currentPath: string,
		processedFileNames: Set<string>
	): Promise<{success: number, error: number}> {
		let successCount = 0;
		let errorCount = 0;
		
		try {
			// 1. Get the page content
			const pageContent = await this.getClickUpPageContent(page.id, docId); // Pass docId here
			if (!pageContent) {
				console.error(`Failed to get content for page: ${page.name} (${page.id})`);
				new Notice(`Failed to download content for "${page.name}"`);
				errorCount++;
				// Still continue with children even if content fetch failed
			} else {
				// 2. Create/prepare the file path
				let fileName = this.sanitizeFileName(page.name);
				
				// Handle duplicate file names by adding page ID
				if (processedFileNames.has(fileName)) {
					fileName = `${fileName}-${page.id.substring(0, 8)}`;
				}
				processedFileNames.add(fileName);
				
				// Add .md extension if needed
				if (!fileName.endsWith('.md')) {
					fileName += '.md';
				}
				
				// Prepare the full path
				const filePath = `${basePath}${currentPath}${fileName}`;
				
				// Check if a file with this name already exists in the destination folder
				const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
				const existingFiles = dirPath 
					? this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(dirPath + '/'))
					: this.app.vault.getMarkdownFiles();
				
				const existingFile = existingFiles.find(f => f.basename === fileName.replace('.md', ''));
				
				// 3. Create or update the file
				try {
					if (existingFile) {
						// Update existing file
						await this.app.vault.modify(existingFile, pageContent);
						console.log(`Updated existing file: ${existingFile.path}`);
					} else {
						// Create directories if needed
						if (dirPath && !this.app.vault.getAbstractFileByPath(dirPath)) {
							await this.app.vault.createFolder(dirPath);
						}
						
						// Create new file
						await this.app.vault.create(filePath, pageContent);
						console.log(`Created new file: ${filePath}`);
					}
					
					// Update page mapping in settings using the docId
					const mappingKey = `${docId}:::${filePath}`;
					this.settings.pageMapping[mappingKey] = page.id;
					await this.saveSettings();
					
					successCount++;
				} catch (writeError) {
					console.error(`Error writing file ${filePath}:`, writeError);
					new Notice(`Error writing file ${fileName}`);
					errorCount++;
				}
			}
			
			// 4. Process children recursively
			if (page.pages && page.pages.length > 0) {
				// Create a subfolder for children if the current page has children
				const newSubfolderPath = currentPath + this.sanitizeFileName(page.name) + '/';
				
				// Create the subfolder if it doesn't exist
				const subfolderFullPath = basePath + newSubfolderPath;
				if (!this.app.vault.getAbstractFileByPath(subfolderFullPath)) {
					try {
						await this.app.vault.createFolder(subfolderFullPath);
						console.log(`Created subfolder: ${subfolderFullPath}`);
					} catch (folderError) {
						console.error(`Error creating subfolder ${subfolderFullPath}:`, folderError);
						// Continue anyway, as we might be able to create files
					}
				}
				
				// Process each child
				for (const child of page.pages) {
					const childResults = await this.processClickUpPageForDownload(
						child,
						docId, // Pass the docId to children
						basePath,
						newSubfolderPath,
						processedFileNames
					);
					
					successCount += childResults.success;
					errorCount += childResults.error;
				}
			}
		} catch (error) {
			console.error(`Error processing page ${page.name}:`, error);
			errorCount++;
		}
		
		return { success: successCount, error: errorCount };
	}

	/**
	 * Gets the markdown content for a ClickUp page
	 * @param pageId ClickUp page ID
	 * @param docId Optional: The ClickUp Doc ID containing this page (if known)
	 * @returns The markdown content or null if failed
	 */
	async getClickUpPageContent(pageId: string, docId?: string): Promise<string | null> {
		const { clickUpApiKey, clickUpWorkspaceId } = this.settings;
		
		try {
			// If docId wasn't provided, we need to determine which Doc this page belongs to
			if (!docId) {
				// Look through the mapping keys to find the Doc ID 
				// Mapping keys are in format: ${docId}:::${filePath}
				for (const key of Object.keys(this.settings.pageMapping)) {
					if (this.settings.pageMapping[key] === pageId) {
						const parts = key.split(':::');
						if (parts.length === 2) {
							docId = parts[0];
							break;
						}
					}
				}
				
				// If we can't find the docId in mappings, try to get it from sync targets
				if (!docId) {
					for (const target of this.settings.syncTargets) {
						// We'll need to fetch pages for each doc to check
						const pages = await this.getClickUpDocPages(target.docId);
						if (pages && pages.some(page => page.id === pageId)) {
							docId = target.docId;
							break;
						}
					}
				}
				
				// If we still don't have a docId, we can't proceed
				if (!docId) {
					console.error(`Cannot determine Doc ID for page ${pageId}`);
					return null;
				}
			}
			
			// First try getting the page content by downloading the page content directly
			// ClickUp API endpoint for page content
			const url = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${pageId}`;
			
			const response = await requestUrl({
				method: 'GET',
				url: url,
				headers: { 'Authorization': clickUpApiKey },
				throw: false,
			});
			
			if (response.status === 200) {
				// ClickUp typically returns page content either in 'content' or 'body'
				// Since we want markdown format, we specify that in our request
				let content = '';
				
				// Check if we need to make a second request to get markdown content
				// Some ClickUp API versions return only metadata in the first request
				if (response.json.id && !response.json.content) {
					// Try a second request with format specified for content
					const contentUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${pageId}/content?format=markdown`;
					
					const contentResponse = await requestUrl({
						method: 'GET',
						url: contentUrl,
						headers: { 'Authorization': clickUpApiKey },
						throw: false,
					});
					
					if (contentResponse.status === 200) {
						// The content might be in different places depending on the API version
						content = contentResponse.json.content || 
							contentResponse.json.markdown || 
							contentResponse.json.text || 
							contentResponse.text || '';
					} else {
						console.error(`Error fetching markdown content for page ${pageId}: ${contentResponse.status}`, contentResponse.json);
					}
				} else {
					// Try to get content from first response
					content = response.json.content || 
						response.json.markdown || 
						response.json.body || 
						response.json.text || '';
				}
				
				// Add a title and metadata to the content
				const pageTitle = response.json.name || 'ClickUp Page';
				const formattedContent =
					// `# ${pageTitle}\n\n` + 
					// `*ClickUp Page ID: ${pageId}*\n\n` +
					content;
				
				return formattedContent;
			} else {
				console.error(`Error fetching content for page ${pageId}: ${response.status}`, response.json);
				return null;
			}
		} catch (error) {
			console.error(`Failed to fetch content for page ${pageId}:`, error);
			return null;
		}
	}

	/**
	 * Sanitizes a file name to be compatible with file systems
	 * @param fileName The original file name
	 * @returns A sanitized file name
	 */
	sanitizeFileName(fileName: string): string {
		// Remove characters that are not allowed in file names
		return fileName
			.replace(/[\\/:*?"<>|]/g, '-') // Replace forbidden characters with dash
			.replace(/\s+/g, ' ')         // Replace multiple spaces with single space
			.trim();                      // Trim leading/trailing spaces
	}

	/**
	 * Helper method to prompt for sync parameters including parent page ID
	 */
	async promptForSyncParams(): Promise<{docId: string, folderPath: string, parentPageId: string} | null> {
		return new Promise((resolve) => {
			const modal = new SyncParamsModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
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
			
			// Create a dedicated buttons container below the inputs
			const buttonContainer = containerEl.createDiv();
			buttonContainer.addClass('clickup-buttons-container');
			buttonContainer.style.marginLeft = '40px'; // Align with input fields
			buttonContainer.style.marginBottom = '20px'; // Add some space before next target
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '10px'; // Space between buttons
			
			// // Sync Down button
			// const syncDownButton = buttonContainer.createEl('button', { 
			// 	text: 'Sync Down',
			// 	cls: 'mod-cta' // Make it stand out (same as setCta())
			// });
			// syncDownButton.addEventListener('click', async () => {
			// 	new Notice(`Starting download from ClickUp Doc ${target.docId} to folder ${target.folderPath || '(Vault Root)'}...`);
			// 	await this.plugin.syncClickUpToVault(target);
			// });
			
			// Sync Children button
			const syncChildrenButton = buttonContainer.createEl('button', {
				text: 'Download Clickup',
				cls: 'mod-cta'
			});
			syncChildrenButton.addEventListener('click', async () => {
				// Prompt for parent page ID
				const parentPageId = await this.promptForParentPageId();
				if (parentPageId) {
					new Notice(`Starting download of child pages from parent ID: ${parentPageId}...`);
					await this.plugin.syncClickUpToVault(target, parentPageId);
				}
			});
			
			// Remove Button
			const removeButton = buttonContainer.createEl('button', { 
				text: 'Remove',
				cls: 'mod-warning' // Make it look deletable (same as setWarning())
			});
			removeButton.addEventListener('click', async () => {
				this.plugin.settings.syncTargets.splice(index, 1); // Remove from array
				await this.plugin.saveSettings();
				this.display(); // Redraw the settings tab to reflect removal
				new Notice('Sync target removed.');
			});
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
	
	/**
	 * Prompts the user for a parent page ID
	 */
	async promptForParentPageId(): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new ParentPageIdModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
	}
}

/**
 * Modal to display the ClickUp page tree structure
 */
class PageTreeModal extends Modal {
	docId: string;
	pageTree: ClickUpPageNode[];
	plugin: ClickUpSyncPlugin;
	
	constructor(app: App, docId: string, pageTree: ClickUpPageNode[], plugin: ClickUpSyncPlugin) {
		super(app);
		this.docId = docId;
		this.pageTree = pageTree;
		this.plugin = plugin;
	}
	
	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		
		contentEl.createEl("h2", { text: `ClickUp Doc Pages Tree (${this.docId})` });
		
		// Create container for tree
		const container = contentEl.createDiv();
		container.addClass("clickup-page-tree-container");
		container.style.maxHeight = "300px";
		container.style.overflowY = "auto";
		container.style.marginBottom = "20px";
		container.style.border = "1px solid var(--background-modifier-border)";
		container.style.padding = "10px";
		
		// Create tree visualization
		this.renderPageTree(container, this.pageTree, 0);
		
		// Add sync option
		const syncOptionContainer = contentEl.createDiv();
		syncOptionContainer.style.marginTop = "20px";
		syncOptionContainer.style.marginBottom = "20px";
		
		const syncHeading = syncOptionContainer.createEl("h3", { text: "Create Sync Target" });
		
		// Folder selector
		const folderSelectorContainer = syncOptionContainer.createDiv();
		folderSelectorContainer.style.marginBottom = "15px";
		
		const folderLabel = folderSelectorContainer.createEl("label", { text: "Obsidian Folder Path:" });
		folderLabel.style.display = "block";
		folderLabel.style.marginBottom = "5px";
		
		const folderInput = folderSelectorContainer.createEl("input", { 
			type: "text",
			placeholder: "Folder path (leave empty for vault root)" 
		});
		folderInput.style.width = "100%";
		
		// Create button to add sync target
		const syncButtonContainer = contentEl.createDiv();
		syncButtonContainer.style.display = "flex";
		syncButtonContainer.style.justifyContent = "space-between";
		
		// Create sync button
		const syncButton = syncButtonContainer.createEl("button", { text: "Create Sync Target" });
		syncButton.style.marginRight = "10px";
		syncButton.addEventListener("click", async () => {
			const folderPath = folderInput.value.trim();
			
			// Check if this target already exists
			const existingTargetIndex = this.plugin.settings.syncTargets.findIndex(
				target => target.docId === this.docId && target.folderPath === folderPath
			);
			
			if (existingTargetIndex >= 0) {
				new Notice(`Sync target already exists for Doc ID: ${this.docId} and folder: ${folderPath || '(Vault Root)'}`);
			} else {
				// Add new sync target
				this.plugin.settings.syncTargets.push({
					docId: this.docId,
					folderPath: folderPath,
					parentPageId: null
				});
				await this.plugin.saveSettings();
				new Notice(`Added new sync target: ${folderPath || '(Vault Root)'} → ${this.docId}`);
				this.close();
			}
		});
		
		// Close button
		const closeButton = syncButtonContainer.createEl("button", { text: "Close" });
		closeButton.addEventListener("click", () => this.close());
	}
	
	/**
	 * Recursively renders the page tree with indentation
	 */
	renderPageTree(container: HTMLElement, pages: ClickUpPageNode[], level: number) {
		pages.forEach(page => {
			const pageEl = container.createDiv();
			pageEl.addClass("clickup-page-item");
			pageEl.style.paddingLeft = `${level * 20}px`; // Indent based on level
			pageEl.style.marginBottom = "5px";
			
			// Create a collapsed/expanded state for pages with children
			if (page.children && page.children.length > 0) {
				const toggleEl = pageEl.createSpan({ text: "▶ " });
				toggleEl.addClass("clickup-page-toggle");
				toggleEl.style.cursor = "pointer";
				toggleEl.style.marginRight = "5px";
				
				let expanded = false;
				toggleEl.addEventListener("click", () => {
					expanded = !expanded;
					toggleEl.textContent = expanded ? "▼ " : "▶ ";
					childrenEl.style.display = expanded ? "block" : "none";
				});
			}
			
			// Page name and ID
			const nameEl = pageEl.createSpan({ 
				text: `${page.name} (ID: ${page.id})` 
			});
			nameEl.style.fontWeight = level === 0 ? "bold" : "normal";
			
			// Add copy ID button
			const copyBtn = pageEl.createEl("button", { text: "Copy ID" });
			copyBtn.style.fontSize = "9px";
			copyBtn.style.marginLeft = "5px";
			copyBtn.style.padding = "0 5px";
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				navigator.clipboard.writeText(page.id);
				new Notice(`Copied ID: ${page.id}`);
			});
			
			// Container for children, initially hidden if there are children
			const childrenEl = container.createDiv();
			childrenEl.addClass("clickup-page-children");
			childrenEl.style.marginLeft = "10px";
			
			if (page.children && page.children.length > 0) {
				childrenEl.style.display = "none"; // Initially collapsed
				this.renderPageTree(childrenEl, page.children, level + 1);
			}
		});
	}
	
	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

/**
 * Modal for Doc ID and folder path input
 */
class DocIdInputModal extends Modal {
	result: {docId: string, folderPath: string} | null = null;
	onSubmit: (result: {docId: string, folderPath: string} | null) => void;
	folderSuggestions: string[] = [];
	
	constructor(app: App, onSubmit: (result: {docId: string, folderPath: string} | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
		
		// Get all folder paths from the vault for suggestions
		this.folderSuggestions = this.getFolderPaths();
	}
	
	/**
	 * Get all folder paths from the vault
	 */
	getFolderPaths(): string[] {
		const folderPaths: string[] = [''];  // Empty string for vault root
		
		// Get all folders in the vault
		const files = this.app.vault.getAllLoadedFiles();
		// Filter for TFolder items using "children" property existence as indicator
		const folders = files.filter(f => 'children' in f);
		
		folders.forEach(folder => {
			if (folder.path) {
				folderPaths.push(folder.path);
			}
		});
		
		return folderPaths;
	}
	
	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		
		contentEl.createEl('h2', {text: 'ClickUp Doc Sync'});
		
		// Create form container
		const formContainer = contentEl.createDiv();
		formContainer.addClass('clickup-form-container');
		formContainer.style.marginBottom = '20px';
		
		// Doc ID input field
		const docIdLabel = formContainer.createEl('label', {text: 'ClickUp Doc ID:'});
		docIdLabel.style.display = 'block';
		docIdLabel.style.marginBottom = '5px';
		docIdLabel.style.fontWeight = 'bold';
		
		const docIdInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter ClickUp Doc ID',
		});
		docIdInput.style.width = '100%';
		docIdInput.style.marginBottom = '15px';
		
		// Focus on the doc ID input field
		docIdInput.focus();
		
		// Folder path input field with suggestions
		const folderLabel = formContainer.createEl('label', {text: 'Obsidian Folder Path:'});
		folderLabel.style.display = 'block';
		folderLabel.style.marginBottom = '5px';
		folderLabel.style.fontWeight = 'bold';
		
		const folderDescription = formContainer.createEl('div', {
			text: 'Leave empty to use vault root. For selecting a subfolder, use path like "folder/subfolder"'
		});
		folderDescription.style.fontSize = '12px';
		folderDescription.style.marginBottom = '5px';
		folderDescription.style.color = 'var(--text-muted)';
		
		const folderInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Folder path (leave empty for vault root)',
		});
		folderInput.style.width = '100%';
		folderInput.style.marginBottom = '15px';
		
		// Dropdown list for folder suggestions
		const suggestionsContainer = formContainer.createDiv();
		suggestionsContainer.style.display = 'none';
		suggestionsContainer.style.border = '1px solid var(--background-modifier-border)';
		suggestionsContainer.style.maxHeight = '150px';
		suggestionsContainer.style.overflowY = 'auto';
		suggestionsContainer.style.marginBottom = '15px';
		suggestionsContainer.style.position = 'relative';
		suggestionsContainer.style.backgroundColor = 'var(--background-primary)';
		
		// Show suggestions when folder input is focused
		folderInput.addEventListener('focus', () => {
			this.updateSuggestions(suggestionsContainer, folderInput, this.folderSuggestions);
			suggestionsContainer.style.display = 'block';
		});
		
		// Filter suggestions when folder input changes
		folderInput.addEventListener('input', () => {
			this.updateSuggestions(suggestionsContainer, folderInput, this.folderSuggestions);
		});
		
		// Hide suggestions when clicking outside
		document.addEventListener('click', (e) => {
			if (e.target !== folderInput && e.target !== suggestionsContainer) {
				suggestionsContainer.style.display = 'none';
			}
		});
		
		// Create buttons
		const buttonContainer = contentEl.createDiv();
		buttonContainer.addClass('clickup-button-container');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';
		
		// Cancel button
		const cancelButton = buttonContainer.createEl('button', {text: 'Cancel'});
		cancelButton.addEventListener('click', () => {
			this.result = null;
			this.close();
		});
		
		// Submit button
		const submitButton = buttonContainer.createEl('button', {text: 'Submit'});
		submitButton.addClass('mod-cta');
		submitButton.addEventListener('click', () => {
			if (docIdInput.value.trim()) {
				this.result = {
					docId: docIdInput.value.trim(),
					folderPath: folderInput.value.trim()
				};
				this.close();
			} else {
				// Show error if Doc ID is empty
				new Notice('Please enter a ClickUp Doc ID');
			}
		});
		
		// Allow Enter key to submit
		const handleEnter = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				if (docIdInput.value.trim()) {
					this.result = {
						docId: docIdInput.value.trim(),
						folderPath: folderInput.value.trim()
					};
					this.close();
				} else {
					// Show error if Doc ID is empty
					new Notice('Please enter a ClickUp Doc ID');
				}
			}
		};
		
		docIdInput.addEventListener('keydown', handleEnter);
		folderInput.addEventListener('keydown', handleEnter);
	}
	
	/**
	 * Update folder path suggestions based on input
	 */
	updateSuggestions(container: HTMLElement, input: HTMLInputElement, allPaths: string[]) {
		container.empty();
		
		const inputValue = input.value.toLowerCase();
		// Filter suggestions based on input
		const filteredPaths = inputValue 
			? allPaths.filter(path => path.toLowerCase().includes(inputValue))
			: allPaths;
		
		// Limit to first 10 matches
		const limitedPaths = filteredPaths.slice(0, 10);
		
		// Create suggestion items
		limitedPaths.forEach(path => {
			const item = container.createDiv();
			item.textContent = path || '(Vault Root)';
			item.style.padding = '5px 10px';
			item.style.cursor = 'pointer';
			
			// Highlight on hover
			item.addEventListener('mouseenter', () => {
				item.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			
			item.addEventListener('mouseleave', () => {
				item.style.backgroundColor = '';
			});
			
			// Select suggestion on click
			item.addEventListener('click', () => {
				input.value = path;
				container.style.display = 'none';
			});
		});
		
		// Show no results message if no matches
		if (limitedPaths.length === 0) {
			const noResults = container.createDiv();
			noResults.textContent = 'No matching folders';
			noResults.style.padding = '5px 10px';
			noResults.style.fontStyle = 'italic';
			noResults.style.color = 'var(--text-muted)';
		}
	}
	
	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		this.onSubmit(this.result);
	}
}

/**
 * Modal for getting sync parameters including parent page ID
 */
class SyncParamsModal extends Modal {
	result: {docId: string, folderPath: string, parentPageId: string} | null = null;
	onSubmit: (result: {docId: string, folderPath: string, parentPageId: string} | null) => void;
	folderSuggestions: string[] = [];
	
	constructor(app: App, onSubmit: (result: {docId: string, folderPath: string, parentPageId: string} | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
		
		// Get all folder paths from the vault for suggestions
		this.folderSuggestions = this.getFolderPaths();
	}
	
	/**
	 * Get all folder paths from the vault
	 */
	getFolderPaths(): string[] {
		const folderPaths: string[] = [''];  // Empty string for vault root
		
		// Get all folders in the vault
		const files = this.app.vault.getAllLoadedFiles();
		// Filter for TFolder items using "children" property existence as indicator
		const folders = files.filter(f => 'children' in f);
		
		folders.forEach(folder => {
			if (folder.path) {
				folderPaths.push(folder.path);
			}
		});
		
		return folderPaths;
	}
	
	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		
		contentEl.createEl('h2', {text: 'Sync ClickUp Child Pages'});
		
		// Create form container
		const formContainer = contentEl.createDiv();
		formContainer.addClass('clickup-form-container');
		formContainer.style.marginBottom = '20px';
		
		// Doc ID input field
		const docIdLabel = formContainer.createEl('label', {text: 'ClickUp Doc ID:'});
		docIdLabel.style.display = 'block';
		docIdLabel.style.marginBottom = '5px';
		docIdLabel.style.fontWeight = 'bold';
		
		const docIdInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter ClickUp Doc ID',
		});
		docIdInput.style.width = '100%';
		docIdInput.style.marginBottom = '15px';
		
		// Focus on the doc ID input field
		docIdInput.focus();
		
		// Parent Page ID input field
		const parentPageIdLabel = formContainer.createEl('label', {text: 'Parent Page ID:'});
		parentPageIdLabel.style.display = 'block';
		parentPageIdLabel.style.marginBottom = '5px';
		parentPageIdLabel.style.fontWeight = 'bold';
		
		const parentPageIdDescription = formContainer.createEl('div', {
			text: 'Enter the ID of the parent page whose children you want to sync'
		});
		parentPageIdDescription.style.fontSize = '12px';
		parentPageIdDescription.style.marginBottom = '5px';
		parentPageIdDescription.style.color = 'var(--text-muted)';
		
		const parentPageIdInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter Parent Page ID',
		});
		parentPageIdInput.style.width = '100%';
		parentPageIdInput.style.marginBottom = '15px';
		
		// Folder path input field with suggestions
		const folderLabel = formContainer.createEl('label', {text: 'Obsidian Folder Path:'});
		folderLabel.style.display = 'block';
		folderLabel.style.marginBottom = '5px';
		folderLabel.style.fontWeight = 'bold';
		
		const folderDescription = formContainer.createEl('div', {
			text: 'Leave empty to use vault root. For selecting a subfolder, use path like "folder/subfolder"'
		});
		folderDescription.style.fontSize = '12px';
		folderDescription.style.marginBottom = '5px';
		folderDescription.style.color = 'var(--text-muted)';
		
		const folderInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Folder path (leave empty for vault root)',
		});
		folderInput.style.width = '100%';
		folderInput.style.marginBottom = '15px';
		
		// Dropdown list for folder suggestions
		const suggestionsContainer = formContainer.createDiv();
		suggestionsContainer.style.display = 'none';
		suggestionsContainer.style.border = '1px solid var(--background-modifier-border)';
		suggestionsContainer.style.maxHeight = '150px';
		suggestionsContainer.style.overflowY = 'auto';
		suggestionsContainer.style.marginBottom = '15px';
		suggestionsContainer.style.position = 'relative';
		suggestionsContainer.style.backgroundColor = 'var(--background-primary)';
		
		// Show suggestions when folder input is focused
		folderInput.addEventListener('focus', () => {
			this.updateSuggestions(suggestionsContainer, folderInput, this.folderSuggestions);
			suggestionsContainer.style.display = 'block';
		});
		
		// Filter suggestions when folder input changes
		folderInput.addEventListener('input', () => {
			this.updateSuggestions(suggestionsContainer, folderInput, this.folderSuggestions);
		});
		
		// Hide suggestions when clicking outside
		document.addEventListener('click', (e) => {
			if (e.target !== folderInput && e.target !== suggestionsContainer) {
				suggestionsContainer.style.display = 'none';
			}
		});
		
		// Create buttons
		const buttonContainer = contentEl.createDiv();
		buttonContainer.addClass('clickup-button-container');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';
		
		// Cancel button
		const cancelButton = buttonContainer.createEl('button', {text: 'Cancel'});
		cancelButton.addEventListener('click', () => {
			this.result = null;
			this.close();
		});
		
		// Submit button
		const submitButton = buttonContainer.createEl('button', {text: 'Submit'});
		submitButton.addClass('mod-cta');
		submitButton.addEventListener('click', () => {
			if (docIdInput.value.trim() && parentPageIdInput.value.trim()) {
				this.result = {
					docId: docIdInput.value.trim(),
					folderPath: folderInput.value.trim(),
					parentPageId: parentPageIdInput.value.trim()
				};
				this.close();
			} else {
				// Show error if required fields are empty
				new Notice('Please enter both Doc ID and Parent Page ID');
			}
		});
		
		// Allow Enter key to submit
		const handleEnter = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				if (docIdInput.value.trim() && parentPageIdInput.value.trim()) {
					this.result = {
						docId: docIdInput.value.trim(),
						folderPath: folderInput.value.trim(),
						parentPageId: parentPageIdInput.value.trim()
					};
					this.close();
				} else {
					// Show error if required fields are empty
					new Notice('Please enter both Doc ID and Parent Page ID');
				}
			}
		};
		
		docIdInput.addEventListener('keydown', handleEnter);
		folderInput.addEventListener('keydown', handleEnter);
		parentPageIdInput.addEventListener('keydown', handleEnter);
	}
	
	/**
	 * Update folder path suggestions based on input
	 */
	updateSuggestions(container: HTMLElement, input: HTMLInputElement, allPaths: string[]) {
		container.empty();
		
		const inputValue = input.value.toLowerCase();
		// Filter suggestions based on input
		const filteredPaths = inputValue 
			? allPaths.filter(path => path.toLowerCase().includes(inputValue))
			: allPaths;
		
		// Limit to first 10 matches
		const limitedPaths = filteredPaths.slice(0, 10);
		
		// Create suggestion items
		limitedPaths.forEach(path => {
			const item = container.createDiv();
			item.textContent = path || '(Vault Root)';
			item.style.padding = '5px 10px';
			item.style.cursor = 'pointer';
			
			// Highlight on hover
			item.addEventListener('mouseenter', () => {
				item.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			
			item.addEventListener('mouseleave', () => {
				item.style.backgroundColor = '';
			});
			
			// Select suggestion on click
			item.addEventListener('click', () => {
				input.value = path;
				container.style.display = 'none';
			});
		});
		
		// Show no results message if no matches
		if (limitedPaths.length === 0) {
			const noResults = container.createDiv();
			noResults.textContent = 'No matching folders';
			noResults.style.padding = '5px 10px';
			noResults.style.fontStyle = 'italic';
			noResults.style.color = 'var(--text-muted)';
		}
	}
	
	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		this.onSubmit(this.result);
	}
}

/**
 * Modal for prompting just the parent page ID
 */
class ParentPageIdModal extends Modal {
	result: string | null = null;
	onSubmit: (result: string | null) => void;
	
	constructor(app: App, onSubmit: (result: string | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}
	
	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		
		contentEl.createEl('h2', {text: 'Sync ClickUp Child Pages'});
		
		// Create form container
		const formContainer = contentEl.createDiv();
		formContainer.addClass('clickup-form-container');
		formContainer.style.marginBottom = '20px';
		
		// Parent Page ID input field
		const parentPageIdLabel = formContainer.createEl('label', {text: 'Parent Page ID:'});
		parentPageIdLabel.style.display = 'block';
		parentPageIdLabel.style.marginBottom = '5px';
		parentPageIdLabel.style.fontWeight = 'bold';
		
		const parentPageIdDescription = formContainer.createEl('div', {
			text: 'Enter the ID of the parent page whose children you want to sync'
		});
		parentPageIdDescription.style.fontSize = '12px';
		parentPageIdDescription.style.marginBottom = '5px';
		parentPageIdDescription.style.color = 'var(--text-muted)';
		
		const parentPageIdInput = formContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter Parent Page ID',
		});
		parentPageIdInput.style.width = '100%';
		parentPageIdInput.style.marginBottom = '15px';
		
		// Focus on the input field
		parentPageIdInput.focus();
		
		// Create buttons
		const buttonContainer = contentEl.createDiv();
		buttonContainer.addClass('clickup-button-container');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';
		
		// Cancel button
		const cancelButton = buttonContainer.createEl('button', {text: 'Cancel'});
		cancelButton.addEventListener('click', () => {
			this.result = null;
			this.close();
		});
		
		// Submit button
		const submitButton = buttonContainer.createEl('button', {text: 'Submit'});
		submitButton.addClass('mod-cta');
		submitButton.addEventListener('click', () => {
			if (parentPageIdInput.value.trim()) {
				this.result = parentPageIdInput.value.trim();
				this.close();
			} else {
				// Show error if the field is empty
				new Notice('Please enter a Parent Page ID');
			}
		});
		
		// Allow Enter key to submit
		parentPageIdInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				if (parentPageIdInput.value.trim()) {
					this.result = parentPageIdInput.value.trim();
					this.close();
				} else {
					// Show error if the field is empty
					new Notice('Please enter a Parent Page ID');
				}
			}
		});
	}
	
	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		this.onSubmit(this.result);
	}
}
