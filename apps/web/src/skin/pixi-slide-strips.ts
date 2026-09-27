import { Container, Mesh, MeshGeometry } from 'pixi.js';
import { skinTexture } from './pixi.js';
import { slideMesh } from './slide-mesh.js';

export interface SlideStripEntry {
  id: string;
  key: string;
  rendererIndex: number;
  points: readonly { x: number; y: number }[];
  width: number;
  textureScale: readonly number[];
  textureOffset: readonly number[];
  alpha: number;
}

/** Owns strip geometry, but shares original PNG textures with the note layer. */
export class PixiSlideStrips {
  readonly container = new Container();
  private readonly meshes = new Map<string, Mesh>();

  constructor() {
    this.container.sortableChildren = true;
  }

  render(entries: readonly SlideStripEntry[], centerX: number, centerY: number, unitScale: number): void {
    this.container.position.set(centerX, centerY);
    this.container.scale.set(unitScale);
    const visible = new Set<string>();
    for (const [order, entry] of entries.entries()) {
      const data = slideMesh(entry.points, entry.width, entry.textureScale, entry.textureOffset);
      if (data.indices.length === 0) continue;
      visible.add(entry.id);
      let mesh = this.meshes.get(entry.id);
      if (!mesh) {
        const geometry = new MeshGeometry(data);
        // Repeated UVs must reach the texture sampler unchanged.
        geometry.batchMode = 'no-batch';
        mesh = new Mesh({ geometry, texture: skinTexture(entry.key) });
        this.meshes.set(entry.id, mesh);
        this.container.addChild(mesh);
      } else {
        mesh.geometry.uvs = data.uvs;
        mesh.geometry.positions = data.positions;
        mesh.geometry.indices = data.indices;
        mesh.texture = skinTexture(entry.key);
      }
      if (mesh.texture.source.style.addressModeU !== 'repeat') {
        mesh.texture.source.style.addressModeU = 'repeat';
        mesh.texture.source.style.update();
      }
      mesh.alpha = Math.max(0, Math.min(1, entry.alpha));
      mesh.zIndex = order;
    }
    for (const [id, mesh] of this.meshes) {
      if (visible.has(id)) continue;
      this.destroyMesh(mesh);
      this.meshes.delete(id);
    }
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) this.destroyMesh(mesh);
    this.meshes.clear();
    this.container.destroy();
  }

  private destroyMesh(mesh: Mesh): void {
    const geometry = mesh.geometry;
    mesh.removeFromParent();
    mesh.destroy({ texture: false, textureSource: false });
    geometry.destroy();
  }
}
