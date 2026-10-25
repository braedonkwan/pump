const elements = new Map<string, Element>();

export function element<T extends Element = HTMLElement>(selector: string): T {
  const found = elements.get(selector) ?? document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  elements.set(selector, found);
  return found as T;
}

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
