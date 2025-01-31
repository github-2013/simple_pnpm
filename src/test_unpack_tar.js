import fs from "fs";
import child_process from "child_process";

// const resolved = 'https://registry.npmjs.org/minimist/-/minimist-1.2.8.tgz'
const resolved = './src/test_materials/minimist-1.2.8.tgz'
const unpackDir = '.pnpm/minimist@1.2.8/node_modules/minimist'


const spawn = (args, opts) => child_process.spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });

const unpack = (archive, to) => {
    fs.mkdirSync(to, { recursive: true });
    spawn([
        'tar',
        '-x',
        '-f', archive,
        '-C', to,
        '--strip-components=1', // first component is always "package"
    ]);
};

unpack(resolved, unpackDir)
