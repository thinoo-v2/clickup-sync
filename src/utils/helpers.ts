import { TFile } from 'obsidian';
import { ClickUpPageNode } from '../models/clickupTypes';
import { SyncTarget } from '../models/settings';

/**
 * Checks if a file is within any of the configured sync target folders.
 * Returns the matching SyncTarget or null if none found.
 */
export function findSyncTargetForFile(file: TFile, syncTargets: SyncTarget[]): SyncTarget | null {
    if (!syncTargets || syncTargets.length === 0) {
        // If no targets are configured, return null indicating no specific target matched
        return null;
    }

    for (const target of syncTargets) {
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
 * Recursively finds a page in the tree by its name
 * @param name Page name to search for
 * @param pages Array of pages to search through
 * @returns The found page or null if not found
 */
export function findPageByNameInTree(name: string, pages: ClickUpPageNode[]): ClickUpPageNode | null {
    for (const page of pages) {
        if (page.name === name) {
            return page;
        }
        
        // Search in children array
        if (page.children && page.children.length > 0) {
            const foundInChildren = findPageByNameInTree(name, page.children);
            if (foundInChildren) {
                return foundInChildren;
            }
        }
        
        // Also search in pages array if it exists (API may use this instead of children)
        if (page.pages && page.pages.length > 0 && 
            // Avoid duplicate search if pages is the same as children
            JSON.stringify(page.pages) !== JSON.stringify(page.children)) {
            const foundInPages = findPageByNameInTree(name, page.pages);
            if (foundInPages) {
                return foundInPages;
            }
        }
    }
    
    return null;
}

/**
 * Sanitizes a file name to be compatible with file systems
 * @param fileName The original file name
 * @returns A sanitized file name
 */
export function sanitizeFileName(fileName: string): string {
    // Remove characters that are not allowed in file names
    return fileName
        .replace(/[\\/:*?"<>|]/g, '-') // Replace forbidden characters with dash
        .replace(/\s+/g, ' ')         // Replace multiple spaces with single space
        .trim();                      // Trim leading/trailing spaces
} 