const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

function evaluateBrowserSpecificSettings(browser, manifestValue, isTop = true) {
  const recurse = (browser, value) => {
    return evaluateBrowserSpecificSettings(browser, value, false);
  };

  if (typeof manifestValue !== "object") {
    return manifestValue;
  }

  if (Array.isArray(manifestValue)) {
    return manifestValue.map((v) => recurse(browser, v));
  }

  const obj = manifestValue;
  var result = {};
  for (const key in obj) {
    const value = obj[key];
    if (key !== "browser_specific_settings") {
      result[key] = recurse(browser, value);
      continue;
    }

    if (browser === "gecko" && isTop) {
      result[key] = { gecko: value["gecko"] };
      continue;
    }

    if (typeof value !== "object") {
      throw `Invalid browser_specific_settings value: "${value}"`;
    }

    var browserValue;
    if (browser in value) {
      browserValue = value[browser];
    } else if ("default" in value) {
      browserValue = value["default"];
    } else {
      continue;
    }

    result = {
      ...result,
      ...browserValue,
    };
  }
  return result;
}

module.exports = (env, argv) => {
  const browser = env.browser;
  if (browser === undefined) {
    throw "Missing target browser";
  }
  if (!["chrome", "gecko"].includes(browser)) {
    throw `Invalid target browser: ${browser}`;
  }

  const transformManifest = (manifestContents) => {
    var manifest = JSON.parse(manifestContents.toString());
    manifest = evaluateBrowserSpecificSettings(browser, manifest);
    return JSON.stringify(manifest);
  };

  return {
    entry: {
      background: path.resolve(__dirname, "..", "src", "background.ts"),
      content: path.resolve(__dirname, "..", "src", "content.ts"),
    },
    output: {
      path: path.join(__dirname, `../dist/${browser}`),
      filename: "[name].js",
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: ".", to: ".", context: "public" },
          { from: "manifest.json", to: ".", transform: transformManifest },
        ],
      }),
    ],
  };
};
