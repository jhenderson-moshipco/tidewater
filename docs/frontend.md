# Frontend guide

Tidewater has four goals: performance, simplicity, support for every operating system, and customizability. The frontend serves those goals by doing as little work as it can. The Rust core owns every database connection and all heavy data movement, and the React frontend in `apps/desktop/src` only renders what the core supplies.

React is used for its simplicity and its built-in hooks, not as a framework to lean on. Write code that stays close to plain JavaScript and HTML, style it with CSS modules and the theme variables, and keep the number of renders low please. In a client like this, speed depends mostly on how many times the UI re-renders while data is loading.

## Where state lives

| Kind of state | Where it goes |
|---|---|
| Connections, query execution, result streaming, performance sampling | The Rust core |
| Working data the UI renders | A Zustand store, read through selectors that returned typed values applicable to the interface |
| Client state that should survive a reload of the window | `sessionStorage`, typed in TypeScript, without React |
| Lists and definitions known ahead of time, such as the workspace views | Constants in code, like `src/shell/views.ts`, are never fetched in an API call |

Components read the store through selectors and call its actions from event handlers. Code outside React, such as an event listener, reads and updates the store with `useStore.getState()`.

## Effects

`useEffect` is a last resort. Use it only for a real client-side effect the user needs to see change on screen, such as the request that loads data into one of the shared data-fetching structures. Every effect adds work after a render and often causes another render, so an effect that isn't needed makes the app slower.

Before writing an effect, use the table below to decide an option, if none match, useEffect is allowed:

| You want to | Do this instead |
|---|---|
| Show a value derived from props or state | computed during render |
| Respond to a click, key press or submit | event handlers |
| Listen to the Rust core, the native menu or a window event | Register the listener once at startup, outside React, and update the store from it. `src/shell/menu-commands.ts` is a good example. |
| Change how something looks between light and dark | Use the theme variables in `src/theme.css`, or the `only-dark` and `only-light` classes |
| Avoid recomputing something expensive | Rely on the React Compiler, which the app is built with, or move the work to Rust |
| Keep a value across reloads | Read it from `sessionStorage` when the store is created |

## Components

- Use native HTML elements first: `<button>`, `<dialog>` for modals, `<select>`, `<details>`. A `title` attribute is enough for a tooltip on a labelled button. Add a library only for a widget that HTML can't do accessibly, and only for that widget.
- Style with CSS modules next to the component, using the `--tw-*` variables from `src/theme.css` for every color, so themes keep working.
- A component takes a single typed view-model object rather than a long list of props.
- Every control has an accessible name and works from the keyboard. Results of async actions are announced, and nothing is signalled by color alone.

## Naming and style

- File names are lowercase and hyphenated: `activity-bar.tsx`, `menu-commands.ts`. Tool config files keep the names their tools expect.
- Components are PascalCase, functions camelCase, and variables snake_case.
- Typescript `any` is not allowed.
- Comment only when code conflicts the standard pattern. 

## Checking a change

Run the typecheck before opening a pull request:

```bash
pnpm typecheck
```

When a change touches data loading or a component that renders often, open the webview's developer tools while running `pnpm dev`, record with the React profiler, and check that the number of renders didn't go up. If the render count goes up without adding significant functionlity, your PR will likely not be approved.
