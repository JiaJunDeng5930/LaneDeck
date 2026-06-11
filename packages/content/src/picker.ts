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
let pickerListening = false;

export function setPickerListening(enabled: boolean): void {
  pickerListening = enabled;
}

export function registerPickTarget(target: PickTarget): PickRegistration {
  target.element.setAttribute("data-pick-id", target.pickId);

  const enter = () => {
    if (!pickerListening) {
      return;
    }
    target.element.setAttribute("data-pick-state", "highlighted");
  };
  const leave = () => {
    if (!pickerListening) {
      return;
    }
    target.element.setAttribute("data-pick-state", "registered");
  };
  const click = (event: Event) => {
    if (!pickerListening) {
      return;
    }

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
