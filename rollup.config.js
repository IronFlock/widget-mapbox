import replace from '@rollup/plugin-replace'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import commonjs from '@rollup/plugin-commonjs'
import babel from '@rollup/plugin-babel'
import { string } from 'rollup-plugin-string'
import { readFileSync, cpSync, mkdirSync } from 'fs'
const npmPackage = JSON.parse(readFileSync('./package.json'))

export default {
    // if you use createSpaConfig, you can use your index.html as entrypoint,
    // any <script type="module"> inside will be bundled by rollup
    input: ['./src/widget-mapbox.ts'],
    treeshake: {
        moduleSideEffects: false
    },
    output: {
        dir: './dist',
        sourcemap: true,
        name: 'widget-mapbox_bundle',
        banner: `/* @license Copyright (c) 2023 Record Evolution GmbH. All rights reserved.*/`,
        format: 'esm'
    },
    plugins: [
        replace({
            versionplaceholder: npmPackage.version,
            preventAssignment: true
        }),
        // CSS and the marker icons are inlined as strings
        string({ include: [/\.css(\?.*)?$/, /\.svg$/] }),
        typescript({ sourceMap: true }),
        nodeResolve(),
        commonjs({}),
        babel({ babelHelpers: 'bundled' }),
        // The emitted dist/src/widget-mapbox.d.ts imports './definition-schema.js', but tsc never
        // copies a hand-maintained .d.ts into outDir, so ship the generated schema types beside it.
        {
            name: 'copy-schema-types',
            writeBundle() {
                mkdirSync('dist/src', { recursive: true })
                cpSync('src/definition-schema.d.ts', 'dist/src/definition-schema.d.ts')
            }
        }
    ]

    // alternatively, you can use your JS as entrypoint for rollup and
    // optionally set a HTML template manually
    // input: './app.js',
}
