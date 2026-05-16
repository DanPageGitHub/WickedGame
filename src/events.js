export function createEventBus() {
  const target = new EventTarget();

  return {
    on(type, listener) {
      const wrapped = (event) => listener(event.detail);
      target.addEventListener(type, wrapped);

      return () => {
        target.removeEventListener(type, wrapped);
      };
    },
    emit(type, detail = {}) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    }
  };
}
