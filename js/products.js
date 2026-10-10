/**
 * MinimalKicks — Dynamic Inventory & Brand Storage Engine
 * - Zero dummy products (displays only real shoes uploaded by Admin)
 * - Dynamic Brands API (Admin can add/remove any brand)
 * - Uses local server API (/api/products & /api/brands) with IndexedDB/localStorage fallback
 */

const DEFAULT_STORE_BRANDS = [
  "Nike",
  "Adidas",
  "New Balance",
  "Puma",
  "On Cloud",
  "Birkenstock",
  "Crocs",
  "Onitsuka Tiger",
  "Girls"
];

const STORE_CATEGORIES = [
  "Sneakers",
  "Running",
  "High Tops",
  "Low Tops",
  "Clogs & Mules",
  "Slides & Sandals",
  "Lifestyle"
];

const STANDARD_SIZES = [
  { uk: "UK 3",  eu: "EU 35", cm: "21.5 cm" },
  { uk: "UK 4",  eu: "EU 37", cm: "23.5 cm" },
  { uk: "UK 5",  eu: "EU 38", cm: "24.0 cm" },
  { uk: "UK 6",  eu: "EU 39", cm: "24.5 cm" },
  { uk: "UK 7",  eu: "EU 41", cm: "26.0 cm" },
  { uk: "UK 8",  eu: "EU 42", cm: "26.5 cm" },
  { uk: "UK 9",  eu: "EU 43", cm: "27.5 cm" },
  { uk: "UK 10", eu: "EU 44", cm: "28.5 cm" },
  { uk: "UK 11", eu: "EU 45", cm: "29.5 cm" },
  { uk: "UK 12", eu: "EU 46", cm: "30.5 cm" }
];

function getAuthHeaders() {
  const token = (typeof window.getAdminToken === 'function' ? window.getAdminToken() : '') ||
                sessionStorage.getItem('mk_admin_token') ||
                localStorage.getItem('mk_admin_token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * Dynamic Brands API (Server + LocalStorage Sync)
 */
const BrandsAPI = {
  async fetchAll() {
    try {
      const res = await fetch('/api/brands', { cache: 'no-store' });
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          localStorage.setItem('mk_brands', JSON.stringify(list));
          return list;
        }
      }
    } catch (_) {}

    try {
      const saved = JSON.parse(localStorage.getItem('mk_brands') || 'null');
      if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch (_) {}

    localStorage.setItem('mk_brands', JSON.stringify(DEFAULT_STORE_BRANDS));
    return [...DEFAULT_STORE_BRANDS];
  },

  async add(brandName) {
    const clean = (brandName || '').trim();
    if (!clean) return await this.fetchAll();

    try {
      const res = await fetch('/api/brands', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: clean })
      });
      if (res.ok) {
        const updated = await res.json();
        localStorage.setItem('mk_brands', JSON.stringify(updated));
        return updated;
      }
    } catch (_) {}

    const current = await this.fetchAll();
    if (!current.some(b => b.toLowerCase() === clean.toLowerCase())) {
      current.push(clean);
      localStorage.setItem('mk_brands', JSON.stringify(current));
    }
    return current;
  },

  async remove(brandName) {
    const clean = (brandName || '').trim();
    try {
      const res = await fetch(`/api/brands/${encodeURIComponent(clean)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const updated = await res.json();
        localStorage.setItem('mk_brands', JSON.stringify(updated));
        return updated;
      }
    } catch (_) {}

    let current = await this.fetchAll();
    current = current.filter(b => b.toLowerCase() !== clean.toLowerCase());
    localStorage.setItem('mk_brands', JSON.stringify(current));
    return current;
  }
};

/**
 * IndexedDB Adapter (handles large system photo uploads when opened without server)
 */
const IDB_NAME = 'MinimalKicksDB_v1';
const IDB_STORE = 'shoes';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll() {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return [];
  }
}

async function idbSave(product) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.put(product);
    tx.oncomplete = () => resolve(product);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Unified Inventory API (Server-first + IndexedDB sync)
 */
const InventoryAPI = {
  async fetchAll() {
    localStorage.removeItem('mk_custom_products');

    let serverItems = [];
    let apiAvailable = false;

    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          serverItems = data;
          apiAvailable = true;
        }
      }
    } catch (_) {}

    if (!apiAvailable) {
      try {
        const staticRes = await fetch('data/products.json', { cache: 'no-store' });
        if (staticRes.ok) {
          const staticData = await staticRes.json();
          if (Array.isArray(staticData)) {
            serverItems = staticData;
          }
        }
      } catch (_) {}
    }

    if (apiAvailable) {
      try {
        const localItems = await idbGetAll();
        const serverIds = new Set(serverItems.map(s => s && s.id).filter(Boolean));
        // Remove locally cached items that were removed from server
        for (const localItem of localItems) {
          if (localItem && localItem.id && !serverIds.has(localItem.id)) {
            await idbDelete(localItem.id);
          }
        }
        // Cache server items in IndexedDB for offline resilience
        for (const item of serverItems) {
          if (item && item.id) {
            await idbSave(item);
          }
        }
      } catch (_) {}

      serverItems.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return serverItems;
    }

    // Offline fallback when server cannot be reached (e.g. file:/// protocol)
    let localItems = await idbGetAll();
    if ((!localItems || localItems.length === 0) && Array.isArray(window.INITIAL_CATALOG) && window.INITIAL_CATALOG.length > 0) {
      localItems = window.INITIAL_CATALOG.map(x => ({ ...x }));
      for (const item of localItems) {
        try { await idbSave(item); } catch (_) {}
      }
    }
    localItems.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return localItems;
  },

  async create(productData) {
    const brandPrefix = (productData.brand || 'MK').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'SH';
    const uniqueNum = Date.now().toString().slice(-5);
    const newProduct = {
      id: productData.id || `MK-${brandPrefix}-${uniqueNum}`,
      name: productData.name,
      brand: productData.brand,
      category: productData.category || 'Sneakers',
      gender: productData.gender || 'Unisex',
      price: Number(productData.price) || 0,
      mrp: Number(productData.mrp) || Number(productData.price) || 0,
      sizes: productData.sizes || ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'],
      images: productData.images || [],
      edition: productData.edition || 'Master Edition',
      description: productData.description || '',
      inStock: productData.inStock !== false,
      createdAt: new Date().toISOString()
    };

    let serverSaved = false;
    let saved = newProduct;

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(newProduct)
      });
      if (res.ok) {
        saved = await res.json();
        serverSaved = true;
      } else {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('Server create warning:', err);
      await idbSave(newProduct);
      if (!serverSaved && window.location.protocol.startsWith('http')) {
        throw new Error(`Cloud server save failed: ${err.message}`);
      }
    }

    await idbSave(saved);
    return saved;
  },

  async update(id, productData) {
    let serverUpdated = false;
    let updated = { ...productData, id };

    try {
      const res = await fetch(`/api/products/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(productData)
      });
      if (res.ok) {
        updated = await res.json();
        serverUpdated = true;
      } else {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('Server update warning:', err);
      await idbSave(updated);
      if (!serverUpdated && window.location.protocol.startsWith('http')) {
        throw new Error(`Cloud server update failed: ${err.message}`);
      }
    }

    await idbSave(updated);
    return updated;
  },

  async remove(id) {
    try {
      await fetch(`/api/products/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
    } catch (_) {}
    await idbDelete(id);
    return true;
  }
};

window.DEFAULT_STORE_BRANDS = DEFAULT_STORE_BRANDS;
window.STORE_CATEGORIES = STORE_CATEGORIES;
window.STANDARD_SIZES = STANDARD_SIZES;
window.BrandsAPI = BrandsAPI;
window.InventoryAPI = InventoryAPI;
