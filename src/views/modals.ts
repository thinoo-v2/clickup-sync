import { App, Modal, Notice } from 'obsidian';
import ClickUpSyncPlugin from '../main';
import { ClickUpPageNode } from '../models/clickupTypes';

/**
 * Modal to display the ClickUp page tree structure
 */
export class PageTreeModal extends Modal {
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
		container.style.marginBottom = "10px";
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
export class DocIdInputModal extends Modal {
	result: {docId: string, folderPath: string} | null = null;
	onSubmit: (result: {docId: string, folderPath: string} | null) => void;
	folderSuggestions: string[] = [];
	plugin: ClickUpSyncPlugin;
	
	constructor(app: App, onSubmit: (result: {docId: string, folderPath: string} | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
		
		// Get plugin instance to access settings
		// @ts-ignore
		this.plugin = app.plugins.plugins['clickup-sync'];
		
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
		
		// Show workspace info if available
		if (this.plugin && this.plugin.settings.clickUpWorkspaceId) {
			const workspaceId = this.plugin.settings.clickUpWorkspaceId;
			const workspaceInfo = formContainer.createDiv();
			workspaceInfo.createEl('span', {
				text: `Using Workspace ID: ${workspaceId}`
			});
			workspaceInfo.style.marginBottom = '15px';
			workspaceInfo.style.color = 'var(--text-accent)';
		}
		
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
export class SyncParamsModal extends Modal {
	result: {docId: string, folderPath: string, parentPageId: string} | null = null;
	onSubmit: (result: {docId: string, folderPath: string, parentPageId: string} | null) => void;
	folderSuggestions: string[] = [];
	plugin: ClickUpSyncPlugin;
	
	constructor(app: App, onSubmit: (result: {docId: string, folderPath: string, parentPageId: string} | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
		
		// Get plugin instance to access settings
		// @ts-ignore
		this.plugin = app.plugins.plugins['clickup-sync'];
		
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
		
		contentEl.createEl('h2', {text: 'Sync Child Pages from ClickUp'});
		
		// Create form container
		const formContainer = contentEl.createDiv();
		formContainer.addClass('clickup-form-container');
		formContainer.style.marginBottom = '20px';
		
		// Show workspace info if available
		if (this.plugin && this.plugin.settings.clickUpWorkspaceId) {
			const workspaceId = this.plugin.settings.clickUpWorkspaceId;
			const workspaceInfo = formContainer.createDiv();
			workspaceInfo.createEl('span', {
				text: `Using Workspace ID: ${workspaceId}`
			});
			workspaceInfo.style.marginBottom = '15px';
			workspaceInfo.style.color = 'var(--text-accent)';
		}
		
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
export class ParentPageIdModal extends Modal {
	result: string | null = null;
	onSubmit: (result: string | null) => void;
	
	constructor(app: App, onSubmit: (result: string | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}
	
	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		
		contentEl.createEl('h2', {text: 'Enter Parent Page ID'});
		
		const inputEl = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Enter ClickUp page ID'
		});
		
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.marginTop = '1em';
		
		const submitBtn = buttonContainer.createEl('button', {text: 'Submit'});
		submitBtn.addEventListener('click', () => {
			this.result = inputEl.value.trim() || null;
			this.close();
		});
		
		const cancelBtn = buttonContainer.createEl('button', {text: 'Cancel'});
		cancelBtn.style.marginLeft = '1em';
		cancelBtn.addEventListener('click', () => {
			this.close();
		});
	}
	
	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		this.onSubmit(this.result);
	}
} 