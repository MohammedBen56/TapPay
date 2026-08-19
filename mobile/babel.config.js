// @ts-check
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
    // react-native-reanimated v4 delegates its worklet transform to
    // react-native-worklets -- the plugin name changed from
    // "react-native-reanimated/plugin" and MUST be listed last.
    plugins: ["react-native-worklets/plugin"],
  };
};
