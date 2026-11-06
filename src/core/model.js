// Shared path helpers and the file-tree model used for squashing layers.
// The tree is a Map from absolute path -> node, with parent/child links.
// Implicit parent directories are materialized on demand; they carry no header
// size and are excluded from file lists (mirrors dive/stereoscope).

const WHITEOUT_PREFIX = '.wh.';
const OPAQUE_MARKER = '.wh..wh..opq';

export function baseName(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function parentPath(path) {
  if (path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function isOpaqueMarker(path) {
  return baseName(path) === OPAQUE_MARKER;
}

export function isWhiteout(path) {
  const b = baseName(path);
  return b.startsWith(WHITEOUT_PREFIX) && b !== WHITEOUT_PREFIX && b !== OPAQUE_MARKER;
}

export function unWhiteoutPath(path) {
  // mirrors stereoscope: parent + basename without the .wh. prefix
  const b = baseName(path).slice(WHITEOUT_PREFIX.length);
  const parent = parentPath(path);
  return parent === '/' ? '/' + b : parent + '/' + b;
}

let nodeId = 0;

export class TreeNode {
  constructor(path, { type = 'directory', linkname = '', size = 0, explicit = false, header = null } = {}) {
    this.id = ++nodeId;
    this.path = path;
    this.type = type;       // directory | file | symlink | hardlink | char | block | fifo | socket | unknown
    this.linkname = linkname;
    this.size = size;       // bytes recorded in the tar header (0 for implicit dirs)
    this.explicit = explicit; // true when a tar header entry created this node
    this.header = header;   // the raw entry (kept for reference, may be dropped)
    this.children = new Set();
    this.parent = null;
  }

  get isDir() {
    return this.type === 'directory';
  }
}

export class FileTree {
  constructor() {
    this.map = new Map();
    this.root = new TreeNode('/', { type: 'directory', explicit: false });
    this.map.set('/', this.root);
  }

  get(path) {
    return this.map.get(path) || null;
  }

  has(path) {
    return this.map.has(path);
  }

  #attach(parentNode, child) {
    parentNode.children.add(child);
    child.parent = parentNode;
  }

  #detach(child) {
    if (child.parent) {
      child.parent.children.delete(child);
      child.parent = null;
    }
  }

  /** Create any missing implicit ancestor directories; returns the direct parent node. */
  #ensureParents(path) {
    const missing = [];
    let cur = parentPath(path);
    while (cur !== '/' && !this.map.has(cur)) {
      missing.push(cur);
      cur = parentPath(cur);
    }
    let parentNode = this.map.get(cur);
    while (missing.length) {
      const p = missing.pop();
      const node = new TreeNode(p, { type: 'directory', explicit: false });
      this.map.set(p, node);
      this.#attach(parentNode, node);
      parentNode = node;
    }
    return this.map.get(parentPath(path));
  }

  /** Insert or update the node at path. Existing children are kept. */
  set(path, attrs = {}) {
    if (path === '/') {
      const root = this.root;
      if (attrs.explicit) {
        if (attrs.type) root.type = attrs.type;
        root.explicit = true;
        root.header = attrs.header ?? root.header;
        root.size = attrs.size ?? 0;
        root.linkname = attrs.linkname ?? '';
      }
      return root;
    }
    const parent = this.#ensureParents(path);
    const existing = this.map.get(path);
    if (existing) {
      if (attrs.type) existing.type = attrs.type;
      existing.linkname = attrs.linkname ?? '';
      existing.size = attrs.size ?? 0;
      if (attrs.explicit !== undefined) existing.explicit = attrs.explicit;
      existing.header = attrs.header ?? null;
      return existing;
    }
    const node = new TreeNode(path, attrs);
    this.map.set(path, node);
    this.#attach(parent, node);
    return node;
  }

  /** Remove the subtree rooted at path (no-op when missing). Returns true when removed. */
  remove(path) {
    const node = this.map.get(path);
    if (!node || path === '/') return false;
    this.#detach(node);
    this.#removeSubtree(node);
    return true;
  }

  #removeSubtree(node) {
    for (const child of [...node.children]) {
      node.children.delete(child);
      child.parent = null;
      this.#removeSubtree(child);
    }
    this.map.delete(node.path);
  }

  /** Remove all children of path, keeping the node itself. */
  removeChildren(path) {
    const node = this.map.get(path);
    if (!node) return;
    for (const child of [...node.children]) {
      node.children.delete(child);
      child.parent = null;
      this.#removeSubtree(child);
    }
  }

  /** All nodes in the subtree rooted at path (including the root of it). */
  subtreeNodes(path) {
    const start = this.map.get(path);
    const out = [];
    if (!start) return out;
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const child of cur.children) stack.push(child);
    }
    return out;
  }

  /** Sum of tar-header sizes over the subtree (implicit dirs count as 0). */
  headerSizeOfSubtree(path) {
    let sum = 0;
    for (const node of this.subtreeNodes(path)) sum += node.size || 0;
    return sum;
  }

  /**
   * Depth-first traversal, children before parent, siblings in path order.
   * Nodes matching skip() are neither visited nor counted as children
   * (mirrors dive's layertree.Walk, used for leaf detection).
   */
  *walk(skip = () => false) {
    const visit = function* (node, isRoot) {
      const children = [...node.children]
        .filter((c) => !skip(c))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const child of children) yield* visit(child, false);
      if (isRoot) return;
      yield { node, leaf: children.length === 0 };
    };
    yield* visit(this.root, true);
  }

  /** Pre-order traversal, parents before children (merge order). */
  *walkPreOrder() {
    const visit = function* (node) {
      yield node;
      const children = [...node.children].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const child of children) yield* visit(child);
    };
    yield* visit(this.root);
  }
}

/**
 * Add a tar entry to a freshly built layer tree. Same-path duplicates in one
 * layer keep their children (matching the "node is replaced in place" rule of
 * stereoscope's file tree builder).
 */
export function treeAddEntry(tree, entry) {
  return tree.set(entry.path, {
    type: entry.type,
    linkname: entry.linkname || '',
    size: entry.size,
    explicit: true,
    header: entry,
  });
}

/**
 * Merge an upper layer tree onto a squashed tree. Mirrors stereoscope's
 * FileTree.Merge (which is what dive analyses):
 *  - opaque markers clear the children of their parent dir in the lower tree
 *  - whiteouts remove the referenced subtree from the lower tree
 *  - other entries graft on top; when old and new are not both directories the
 *    lower node's children are masked (removed); dir over dir keeps them.
 * Entries apply at their literal paths and never through lower symlinks.
 */
export function applyTreeOnto(lower, upper) {
  const opaqueParents = new Set();
  for (const n of upper.map.values()) {
    if (isOpaqueMarker(n.path)) opaqueParents.add(parentPath(n.path));
  }

  for (const upperNode of upper.walkPreOrder()) {
    const p = upperNode.path;
    if (p === '/') {
      if (opaqueParents.has('/')) lower.removeChildren('/');
      continue;
    }
    if (isOpaqueMarker(p)) continue; // marker nodes are never grafted

    if (opaqueParents.has(p)) lower.removeChildren(p);

    if (isWhiteout(p)) {
      lower.remove(unWhiteoutPath(p));
      continue;
    }

    const existing = lower.get(p);
    if (existing) {
      const bothDirs = existing.isDir && upperNode.isDir;
      if (!bothDirs) lower.removeChildren(p);
    }
    lower.set(p, {
      type: upperNode.type,
      linkname: upperNode.linkname,
      size: upperNode.size,
      explicit: upperNode.explicit,
      header: upperNode.header,
    });
  }
}
