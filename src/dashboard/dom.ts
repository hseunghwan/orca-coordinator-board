// A tiny element builder for the dashboard. Text always goes in as text nodes, never as HTML.
export type Child = Node | string | number | null | undefined | false | readonly Child[]
type Value = string | number | boolean | null | undefined | ((event: never) => void)

export function h(tag: string, attrs: Record<string, Value> | null = null, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue
    if (typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value as EventListener)
    else if (name === 'class') element.className = String(value)
    else if (name === 'value') (element as HTMLTextAreaElement).value = String(value)
    else if (name === 'checked') (element as HTMLInputElement).checked = true
    else if (name === 'disabled') (element as HTMLButtonElement).disabled = true
    else if (name === 'open') (element as HTMLDetailsElement).open = true
    else element.setAttribute(name, value === true ? '' : String(value))
  }
  append(element, children)
  return element
}

function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue
    if (Array.isArray(child)) append(parent, child)
    else parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : (child as Node))
  }
}
