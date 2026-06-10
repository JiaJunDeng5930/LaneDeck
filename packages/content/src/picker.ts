export interface PickTarget {
  pickId: string;
  element: HTMLElement;
  label?: string;
}

export interface PickRegistration {
  unregister(): void;
}

type PickListener = (target: PickTarget) => void;

const pickListeners = new Set<PickListener>();

export function registerPickTarget(target: PickTarget): PickRegistration {
  target.element.setAttribute("data-pick-id", target.pickId);

  const enter = () => {
    target.element.setAttribute("data-pick-state", "highlighted");
  };
  const leave = () => {
    target.element.setAttribute("data-pick-state", "registered");
  };
  const click = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    target.element.setAttribute("data-pick-state", "selected");
    notifyPickTarget(target);
    target.element.setAttribute("data-pick-state", "registered");
  };

  target.element.addEventListener("pointerenter", enter);
  target.element.addEventListener("pointerleave", leave);
  target.element.addEventListener("click", click);
  target.element.setAttribute("data-pick-state", "registered");

  return {
    unregister() {
      target.element.removeEventListener("pointerenter", enter);
      target.element.removeEventListener("pointerleave", leave);
      target.element.removeEventListener("click", click);
      target.element.removeAttribute("data-pick-state");
      target.element.removeAttribute("data-pick-id");
    },
  };
}

export function subscribePickTargets(listener: PickListener): PickRegistration {
  pickListeners.add(listener);

  return {
    unregister() {
      pickListeners.delete(listener);
    },
  };
}

function notifyPickTarget(target: PickTarget): void {
  for (const listener of pickListeners) {
    listener(target);
  }
}
