import { Notice, TFile } from 'obsidian';
import { getClickUpDocPages, getClickUpDocPagesTree, getClickUpPageContent, syncFileToClickupPage } from '../api/clickupApi';
import ClickUpSyncPlugin from '../main';
import { ClickUpPageNode } from '../models/clickupTypes';
import { SyncTarget } from '../models/settings';
import { findPageByNameInTree, findSyncTargetForFile, sanitizeFileName } from '../utils/helpers';
import { PageTreeModal } from '../views/modals';

/**
 * Syncs markdown files based on configured sync targets.
 * Iterates through each target, finds matching files, and syncs them.
 */
export async function syncVaultToClickupDoc(this: ClickUpSyncPlugin) {
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
        const existingPagesTree = await getClickUpDocPagesTree(docId, this.settings);
        if (existingPagesTree === null) {
            new Notice(`Failed to get page tree for Doc ${docId}. Skipping this target.`);
            console.error(`Failed to get page tree for Doc ${docId}. Aborting sync for this target.`);
            totalErrorCount++; // Count failure to get pages as an error for the target
            continue; // Move to the next target
        }
        console.log(`Found page tree for ClickUp Doc ${docId}.`);

        // Also get flat list of pages for backward compatibility
        const existingPages = await getClickUpDocPages(docId, this.settings);
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
                    if (!folderPage && existingPagesTree) {
                        const foundInTree = findPageByNameInTree(folderName, existingPagesTree);
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
            const success = await syncFileToClickupPage(file, modifiedTarget, this.settings, existingPages);
            if (success) {
                targetSuccessCount++;
            } else {
                targetErrorCount++;
            }
            
            // Save settings after each file is processed to preserve mappings
            await this.saveSettings();
        }

        console.log(`--- Target "${folderPath || '(Vault Root)'}" Sync Complete: Synced: ${targetSuccessCount}, Failed: ${targetErrorCount} ---`);
        totalSuccessCount += targetSuccessCount;
        totalErrorCount += targetErrorCount;
    } // End loop through syncTargets

    new Notice(`ClickUp Doc Sync finished. Total Synced: ${totalSuccessCount}, Total Failed: ${totalErrorCount}.`);
    console.log(`\n=== ClickUp Doc Sync Overall Complete. Total Synced: ${totalSuccessCount}, Total Failed: ${totalErrorCount} ===`);
}

/**
 * Handles auto-sync when a file is modified (called from the 'modify' event listener if syncOnSave is true)
 */
export async function handleAutoSync(this: ClickUpSyncPlugin, file: TFile) {
    if (!(file instanceof TFile)) return; // Ensure it's a file

    // Find the specific sync target for this modified file
    const syncTarget = findSyncTargetForFile(file, this.settings.syncTargets);

    if (syncTarget) {
        console.log(`Auto-syncing modified file: ${file.path} to Doc ID: ${syncTarget.docId}`);
        
        // Get both tree and flat list for better mapping
        const existingPagesTree = await getClickUpDocPagesTree(syncTarget.docId, this.settings);
        
        // We need the existing pages for potential name matching if the mapping doesn't exist yet
        const existingPages = await getClickUpDocPages(syncTarget.docId, this.settings);
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
                    const foundInTree = findPageByNameInTree(folderName, existingPagesTree);
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
        
        const success = await syncFileToClickupPage(file, modifiedTarget, this.settings, existingPages);
        
        // Save settings to preserve any new mappings
        if (success) {
            await this.saveSettings();
        }
    } else {
        // File not in any configured sync target - silently ignore
    }
}

/**
 * Removes entries from the mapping if the corresponding Obsidian file no longer exists
 * or if the sync target associated with the mapping key is removed.
 * The mapping key format is `${docId}:::${filePath}`.
 */
export async function cleanupPageMapping(this: ClickUpSyncPlugin) {
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
 * Displays the page tree in a modal for visualization
 */
export function displayPageTreeInModal(this: ClickUpSyncPlugin, pageTree: ClickUpPageNode[], docId: string) {
    const modal = new PageTreeModal(this.app, docId, pageTree, this);
    modal.open();
}

/**
 * Syncs pages from ClickUp to Obsidian, creating/updating files to match the ClickUp structure
 * @param target The sync target containing docId and folderPath
 * @param parentPageId Optional parent page ID to filter results
 */
export async function syncClickUpToVault(this: ClickUpSyncPlugin, target: SyncTarget, parentPageId?: string) {
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
    const pageTree = await getClickUpDocPagesTree(docId, this.settings);
    if (!pageTree) {
        new Notice(`Failed to fetch page tree for Doc ${docId}.`);
        return;
    }
    
    console.log(`Found ${pageTree.length} root pages in ClickUp Doc ${docId}. Starting download...`);
    
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
            
            console.log(`Found parent page ${parentPage.name} with ${parentPage.pages.length} children. Processing only these children.`);
            
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
export async function processClickUpPageForDownload(
    this: ClickUpSyncPlugin,
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
        const pageContent = await getClickUpPageContent(page.id, docId, this.settings);
        if (!pageContent) {
            console.error(`Failed to get content for page: ${page.name} (${page.id})`);
            new Notice(`Failed to download content for "${page.name}"`);
            errorCount++;
            // Still continue with children even if content fetch failed
        } else {
            // 2. Create/prepare the file path
            let fileName = sanitizeFileName(page.name);
            
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
            const newSubfolderPath = currentPath + sanitizeFileName(page.name) + '/';
            
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