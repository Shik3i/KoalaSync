export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "scratch/**", "website/www/**"]
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        chrome: "readonly",
        browser: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        fetch: "readonly",
        CustomEvent: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        Uint32Array: "readonly",
        Set: "readonly",
        Map: "readonly",
        Promise: "readonly",
        Array: "readonly",
        Object: "readonly",
        JSON: "readonly",
        Math: "readonly",
        Number: "readonly",
        String: "readonly",
        Date: "readonly",
        Error: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        history: "readonly",
        location: "readonly",
        self: "readonly",
        process: "readonly",
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": "error",
      "no-extra-semi": "error",
      "no-prototype-builtins": "warn",
      "no-unsafe-optional-chaining": "error",
      "valid-typeof": "error"
    }
  },
  {
    files: ["server/**/*.js", "scripts/**/*.js", "scripts/**/*.cjs", "website/build.cjs", "website/**/*.cjs"],
    languageOptions: {
      globals: {
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        module: "readonly",
        exports: "readonly",
        Buffer: "readonly"
      }
    }
  }
];
