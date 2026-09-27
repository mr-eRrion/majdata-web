import { Container, Graphics, NineSliceSprite, Sprite, Texture } from 'pixi.js';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { composeNote, iconFrame, notePlacement, noteSortingOrder, type SkinPart } from './composition.js';
import { loadSkinImage } from './assets.js';
import type { NoteFrame } from './note-state.js';

const PIXELS_PER_UNIT = 100;
const textures = new Map<string, Texture>();
const pendingTextures = new Map<string, Promise<Texture>>();

export interface NoteSpriteEntry {
  note: DisplayNote;
  frame: NoteFrame;
  placement: ReturnType<typeof notePlacement>;
}

export interface SkinSpriteEntry {
  id: string;
  parts: readonly SkinPart[];
  placement: ReturnType<typeof notePlacement>;
  groupOrder?: number;
  depth?: number;
}

export function noteSpriteEntry({ note, frame, placement }: NoteSpriteEntry): SkinSpriteEntry {
  return { id: note.id, parts: composeNote(note, frame), placement,
    groupOrder: note.kind === 'slide' ? 0 : noteSortingOrder(note.kind), depth: note.startSeconds };
}

interface PartSprite {
  signature: string;
  view: Sprite | NineSliceSprite;
  mask?: Graphics;
  progress?: number;
}

interface NoteSprite {
  root: Container;
  parts: PartSprite[];
}

export function loadSkinTexture(key: string): Promise<Texture> {
  const cached = textures.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = pendingTextures.get(key);
  if (!pending) {
    pending = loadSkinImage(key).then((image) => {
      const texture = Texture.from(image);
      textures.set(key, texture);
      return texture;
    }).catch((cause: unknown) => {
      pendingTextures.delete(key);
      throw new Error(`无法加载皮肤纹理“${key}”：${cause instanceof Error ? cause.message : String(cause)}`);
    });
    pendingTextures.set(key, pending);
  }
  return pending;
}

export async function preloadNoteTextures(notes: readonly DisplayNote[]): Promise<void> {
  const keys = new Set(notes.flatMap((note) => composeNote(note, iconFrame).map(({ key }) => key)));
  await Promise.all([...keys].map(loadSkinTexture));
}

export function skinTexture(key: string): Texture {
  const texture = textures.get(key);
  if (!texture) throw new Error(`皮肤纹理尚未就绪：“${key}”`);
  return texture;
}

function createPart(part: SkinPart): PartSprite {
  const texture = skinTexture(part.key);
  const sliced = part.borders !== undefined;
  const view = sliced
    ? new NineSliceSprite({
      texture,
      leftWidth: part.borders![0],
      topHeight: part.borders![1],
      rightWidth: part.borders![2],
      bottomHeight: part.borders![3],
      width: part.width * PIXELS_PER_UNIT,
      height: part.height * PIXELS_PER_UNIT,
      anchor: { x: part.anchorX, y: part.anchorY },
    })
    : new Sprite({ texture, anchor: { x: part.anchorX, y: part.anchorY } });
  const mask = part.progress === undefined ? undefined : new Graphics();
  if (mask) view.mask = mask;
  return { signature: `${part.key}:${part.borders?.join(',') ?? 'sprite'}`, view, mask };
}

function applyPart(sprite: PartSprite, part: SkinPart, zIndex: number): void {
  const { view } = sprite;
  view.position.set(part.x, part.y);
  view.rotation = part.rotation;
  if (view instanceof NineSliceSprite) {
    view.setSize(part.width * PIXELS_PER_UNIT, part.height * PIXELS_PER_UNIT);
    view.scale.set(part.scaleX / PIXELS_PER_UNIT, part.scaleY / PIXELS_PER_UNIT);
  } else {
    view.scale.set(
      part.width / view.texture.orig.width * part.scaleX,
      part.height / view.texture.orig.height * part.scaleY,
    );
  }
  view.alpha = part.alpha;
  view.tint = part.tint;
  view.zIndex = zIndex;
  view.visible = true;
  if (sprite.mask && part.progress !== undefined) {
    const mask = sprite.mask;
    const progress = Math.max(0, Math.min(1, part.progress));
    mask.position.set(part.x, part.y);
    mask.rotation = part.rotation;
    mask.scale.set(part.scaleX, part.scaleY);
    view.visible = progress > 0;
    if (sprite.progress !== progress) {
      sprite.progress = progress;
      const x = (0.5 - part.anchorX) * part.width;
      const y = (0.5 - part.anchorY) * part.height;
      const radius = Math.hypot(part.width, part.height);
      mask.clear();
      // SprFill _CLOCKWISE_ON, _StartAngle=90: top → right → bottom → left.
      if (progress === 1) mask.circle(x, y, radius).fill(0xffffff);
      else if (progress > 0) mask.moveTo(x, y).lineTo(x, y - radius)
        .arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI)
        .closePath().fill(0xffffff);
    }
  }
}

/** Owns reusable note containers and sprites; textures live in a page-level cache. */
export class PixiNoteLayer {
  readonly container = new Container();
  private readonly notes = new Map<string, NoteSprite>();

  constructor() {
    this.container.sortableChildren = true;
  }

  render(entries: readonly NoteSpriteEntry[], centerX: number, centerY: number, unitScale: number): void {
    this.renderParts(entries.map(noteSpriteEntry), centerX, centerY, unitScale);
  }

  renderParts(entries: readonly SkinSpriteEntry[], centerX: number, centerY: number, unitScale: number): void {
    const visibleIds = new Set<string>();
    const sorted = [...entries].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0)
      || (b.depth ?? 0) - (a.depth ?? 0));
    sorted.forEach(({ id, parts, placement }, noteOrder) => {
      visibleIds.add(id);
      let sprite = this.notes.get(id);
      if (!sprite) {
        const root = new Container();
        root.sortableChildren = true;
        this.container.addChild(root);
        sprite = { root, parts: [] };
        this.notes.set(id, sprite);
      }
      const root = sprite.root;
      root.position.set(centerX + placement.x * unitScale, centerY + placement.y * unitScale);
      root.rotation = placement.rotation;
      root.scale.set(unitScale * placement.scale);
      root.zIndex = noteOrder;
      root.visible = true;

      parts.forEach((part, index) => {
        const signature = `${part.key}:${part.borders?.join(',') ?? 'sprite'}`;
        let current = sprite!.parts[index];
        if (!current || current.signature !== signature) {
          if (current) {
            root.removeChild(current.view);
            current.view.destroy({ texture: false, textureSource: false });
            current.mask?.destroy();
          }
          current = createPart(part);
          sprite!.parts[index] = current;
          root.addChild(current.view);
          if (current.mask) root.addChild(current.mask);
        }
        applyPart(current, part, index);
      });
      for (const obsolete of sprite.parts.splice(parts.length)) {
        sprite.root.removeChild(obsolete.view);
        obsolete.view.destroy({ texture: false, textureSource: false });
        obsolete.mask?.destroy();
      }
    });

    for (const [id, sprite] of this.notes) {
      if (visibleIds.has(id)) continue;
      sprite.root.removeFromParent();
      sprite.root.destroy({ children: true, texture: false, textureSource: false });
      this.notes.delete(id);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true, texture: false, textureSource: false });
    this.notes.clear();
  }
}
