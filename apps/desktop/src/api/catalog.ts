import { invoke } from '@tauri-apps/api/core';
import type { CatalogNode, CatalogPath } from '../generated/catalog';

export const catalogChildren = (server_id: string, path: CatalogPath | null, show_system: boolean) =>
  invoke<Array<CatalogNode>>('catalog_children', { server_id, path, show_system });
