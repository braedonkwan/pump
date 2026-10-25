import {
  BACKDROP_OVERLAP,
  getBackdropSegments,
  getBackdropWindow,
  getWorldLayout,
} from '../flight-model.js';
import { find } from './dom.js';
type Scene = ReturnType<typeof getBackdropSegments>[number];
interface Backdrop {
  element: HTMLElement;
  image: HTMLImageElement;
  source: HTMLSourceElement | null;
  scene: Scene;
  requested: boolean;
}

// Geometry is measured only at startup and on viewport resize.
export class WorldGeometry {
  readonly map: HTMLElement;
  width = 0;
  height = 0;
  worldHeight = 0;
  maxOffset = 0;
  private readonly backdrops: Backdrop[] = [];
  constructor(private readonly root: HTMLElement) {
    this.map = find(root, '#world-map');
    this.createBackdrops();
  }

  observe(onResize: () => void): void {
    const resize = (width: number, height: number) => {
      if (
        width <= 0 ||
        height <= 0 ||
        (width === this.width && height === this.height)
      )
        return;
      this.width = width;
      this.height = height;
      const layout = getWorldLayout(width, height, 0);
      this.worldHeight = layout.worldHeight;
      this.maxOffset = layout.maxOffset;
      this.map.style.height = `${layout.worldHeight}px`;
      this.root.style.setProperty('--viewport-width', `${width}px`);
      this.root.style.setProperty('--viewport-height', `${height}px`);
      getBackdropSegments(layout.worldHeight).forEach((segment, index) => {
        const backdrop = this.backdrops[index];
        if (!backdrop) throw new Error('Backdrop element is missing.');
        backdrop.element.style.height = `${segment.height}px`;
        backdrop.element.style.bottom = `${segment.bottom}px`;
      });
      this.root.dataset.cameraMax = String(this.maxOffset);
      onResize();
    };
    new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.borderBoxSize[0];
      resize(
        box?.inlineSize ?? entry.contentRect.width,
        box?.blockSize ?? entry.contentRect.height,
      );
    }).observe(this.root);
    const { width, height } = this.root.getBoundingClientRect();
    resize(width, height);
  }

  load(pumps: number): void {
    for (const scene of getBackdropWindow(this.width, this.height, pumps)) {
      this.loadBackdrop(scene.index, scene.visible);
    }
  }
  private createBackdrops(): void {
    const container = find(this.root, '#world-backdrops');
    for (const [index, segment] of getBackdropSegments(1).entries()) {
      const backdrop = document.createElement('div');
      backdrop.className = 'world-biome';
      backdrop.dataset.biome = segment.id;
      backdrop.style.backgroundColor = segment.color;
      backdrop.style.setProperty('--blend-stop', `${BACKDROP_OVERLAP * 100}%`);
      const image = document.createElement('img');
      image.className = 'world-art';
      image.alt = '';
      image.width = 1536;
      image.height = 1024;
      image.decoding = 'async';
      image.fetchPriority = index === 0 ? 'high' : 'low';
      // Retries and responsive source changes can reload this same element.
      image.addEventListener('load', () => backdrop.classList.add('is-loaded'));
      let source: HTMLSourceElement | null = null;
      if (segment.mobileSrc) {
        const picture = document.createElement('picture');
        source = document.createElement('source');
        source.media = '(max-width: 760px)';
        picture.append(source, image);
        backdrop.append(picture);
      } else {
        backdrop.append(image);
      }
      container.append(backdrop);
      const entry = {
        element: backdrop,
        image,
        source,
        scene: segment,
        requested: false,
      };
      image.addEventListener('error', () => {
        entry.requested = false;
        image.removeAttribute('src');
        source?.removeAttribute('srcset');
        backdrop.classList.remove('is-loaded');
      });
      this.backdrops.push(entry);
    }
  }

  private loadBackdrop(index: number, visible: boolean): void {
    const backdrop = this.backdrops[index];
    if (!backdrop) return;
    backdrop.image.fetchPriority = visible ? 'high' : 'low';
    if (backdrop.requested) return;
    backdrop.requested = true;
    if (backdrop.source && backdrop.scene.mobileSrc)
      backdrop.source.srcset = backdrop.scene.mobileSrc;
    backdrop.image.src = backdrop.scene.src;
  }
}
