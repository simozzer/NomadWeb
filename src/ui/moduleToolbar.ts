import type { ModuleCatalogue, ModuleDef } from '../model/modules.ts';

/** `module-toolbar.json`: the original editor's tabs, each a list of button groups. */
export interface ToolbarLayout {
  tabs: { name: string; groups: number[][] }[];
}

export interface ModuleToolbarOptions {
  layout: ToolbarLayout;
  catalogue: ModuleCatalogue;
  /** Base URL that module icon paths are relative to. */
  dataBase: string;
  /** A module button was clicked without being dragged. */
  onPick: (def: ModuleDef, button: HTMLButtonElement) => void;
  /**
   * A module button was dragged. The pointer stays captured by the button, so
   * the caller follows the gesture from `pointermove` / `pointerup` on window.
   */
  onDragStart?: (def: ModuleDef, event: PointerEvent) => void;
}

/** Movement, in pixels, that turns a press on a button into a drag. */
const DRAG_THRESHOLD = 4;

const TAB_KEY = 'nomad-web.module-tab';

/**
 * The module toolbar, laid out as the Clavia editor's: one tab per category,
 * and under it a single row of icon buttons in that editor's order, with
 * separators between its groups.
 */
export class ModuleToolbar {
  readonly element: HTMLElement;
  private readonly options: ModuleToolbarOptions;
  private readonly tabs: HTMLElement;
  private readonly row: HTMLElement;
  private active: string;

  constructor(options: ModuleToolbarOptions) {
    this.options = options;
    this.element = document.createElement('nav');
    this.element.className = 'module-toolbar';
    this.element.setAttribute('aria-label', 'Modules');

    this.tabs = document.createElement('div');
    this.tabs.className = 'module-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.row = document.createElement('div');
    this.row.className = 'module-row';
    this.row.setAttribute('role', 'tabpanel');
    this.element.append(this.tabs, this.row);

    const names = options.layout.tabs.map((tab) => tab.name);
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(TAB_KEY); } catch { /* not essential */ }
    this.active = remembered && names.includes(remembered) ? remembered : names[0];

    for (const tab of options.layout.tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'module-tab';
      button.setAttribute('role', 'tab');
      button.textContent = tab.name;
      button.addEventListener('click', () => this.show(tab.name));
      this.tabs.appendChild(button);
    }

    // Arrow keys move between tabs, as a tab strip should.
    this.tabs.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const index = names.indexOf(this.active);
      const next = names[(index + (event.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
      this.show(next);
      this.tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      event.preventDefault();
    });

    this.show(this.active);
  }

  show(name: string): void {
    const tab = this.options.layout.tabs.find((t) => t.name === name);
    if (!tab) return;
    this.active = name;
    try { localStorage.setItem(TAB_KEY, name); } catch { /* not essential */ }

    for (const button of Array.from(this.tabs.children) as HTMLButtonElement[]) {
      const selected = button.textContent === name;
      button.classList.toggle('module-tab--active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }

    this.row.replaceChildren();
    tab.groups.forEach((group, i) => {
      if (i > 0) {
        const separator = document.createElement('span');
        separator.className = 'module-separator';
        separator.setAttribute('aria-hidden', 'true');
        this.row.appendChild(separator);
      }
      for (const index of group) {
        const def = this.options.catalogue.modules.get(index);
        if (def) this.row.appendChild(this.button(def));
      }
    });
  }

  private button(def: ModuleDef): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'module-button';
    button.title = def.name;
    button.setAttribute('aria-label', def.name);
    button.dataset.moduleType = String(def.index);
    if (def.icon) {
      const image = document.createElement('img');
      image.src = `${this.options.dataBase}/${def.icon}`;
      image.alt = '';
      image.width = 16;
      image.height = 16;
      // The browser's own image drag would fight the module drag.
      image.draggable = false;
      button.appendChild(image);
    } else {
      button.textContent = def.name.slice(0, 3);
    }

    let dragged = false;
    button.addEventListener('pointerdown', (down: PointerEvent) => {
      if (down.button !== 0 || !this.options.onDragStart) return;
      dragged = false;
      button.setPointerCapture(down.pointerId);
      const move = (event: PointerEvent) => {
        if (dragged) return;
        if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) return;
        dragged = true;
        this.options.onDragStart!(def, event);
      };
      const up = () => {
        button.removeEventListener('pointermove', move);
        button.removeEventListener('pointerup', up);
        button.removeEventListener('pointercancel', up);
      };
      button.addEventListener('pointermove', move);
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
    });
    button.addEventListener('click', () => {
      // A drag ends with a click on the button; it must not open the preview too.
      if (dragged) { dragged = false; return; }
      this.options.onPick(def, button);
    });
    return button;
  }
}
