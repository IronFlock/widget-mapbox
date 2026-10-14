import replace from '@rollup/plugin-replace'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import commonjs from '@rollup/plugin-commonjs'
import babel from '@rollup/plugin-babel'
import { string } from 'rollup-plugin-string'
import { readFileSync, cpSync } from 'fs'
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
        string({ include: [/\.css(\?.*)?$/] }),
        typescript({ sourceMap: true }),
        nodeResolve(),
        commonjs({}),
        babel({ babelHelpers: 'bundled' }),
        // Ships the marker icons next to the bundle. Plain cpSync rather than
        // rollup-plugin-copy, whose globby -> braces chain has no patched release.
        {
            name: 'copy-icons',
            writeBundle() {
                cpSync('icons', 'dist/icons', { recursive: true })
            }
        }
    ]

    // alternatively, you can use your JS as entrypoint for rollup and
    // optionally set a HTML template manually
    // input: './app.js',
}
