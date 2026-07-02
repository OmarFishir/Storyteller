// react-native-reanimated 4.x initializes the real react-native-worklets native
// turbo module as a MODULE-SCOPE side effect (`new NativeWorklets()` inside
// `initializers.ts`, pulled in transitively by `./index`). Under Jest there is no
// native binary, so `globalThis.__workletsModuleProxy` never gets set and the
// constructor crashes with "Cannot read properties of undefined (reading
// 'loadUnpackers')". Reanimated's own shipped `react-native-reanimated/mock`
// re-exports a few utilities (e.g. `Extrapolation`) from that same real `./index`,
// so it hits the identical crash — it does not work standalone under jest-expo
// with this reanimated/worklets version pair.
//
// Fix: hand-roll a minimal mock that never touches the real package at all.
// `Animated.Text` / `Animated.View` render as plain Text/View, and layout/entry
// animation props (which do nothing without a UI runtime) are stripped so RNTL
// can render children synchronously and query them.
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { Text, View } = require('react-native');

  const stripAnimationProps = (Component) =>
    React.forwardRef(({ entering, exiting, layout, ...rest }, ref) =>
      React.createElement(Component, { ref, ...rest })
    );

  return {
    __esModule: true, // required so `import Animated from '...'` binds to `default`
    default: {
      Text: stripAnimationProps(Text),
      View: stripAnimationProps(View),
    },
    FadeInDown: {
      duration: () => ({}),
    },
  };
});
