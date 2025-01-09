#! /usr/bin/env node

const startTime = Date.now();

import { buildDepTree, parseNpmLockV2Project, LockfileType } from 'snyk-nodejs-lockfile-parser';

import which from 'which';
import fs from 'fs';
import child_process from 'child_process';
import path from 'path';

const read = filePath => fs.readFileSync(filePath, 'utf8');

const json = filePath => JSON.parse(read(filePath));

const mkdir = filePath => {
  fs.mkdirSync(filePath, { recursive: true });
};

const spawn = (args, opts) => child_process.spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });

const chmod = fs.chmodSync;

const unpack = (archive, to) => {
  mkdir(to);
  console.log(`unpack: ${archive} -> ${to}`);
  spawn([
    'tar',
    '-x',
    '-f', archive,
    '-C', to,
    '--strip-components=1', // first component is always "package"
  ]);
};

const symlink = (linkTarget, linkPath) => {
  console.log(`symlink: ${linkTarget} -> ${linkPath}`);
  mkdir(path.dirname(linkPath));
  fs.symlinkSync(linkTarget, linkPath);
};

function parseShebang(fileText) {
  // parse shebang line of script file
  // note: shebang line length is limited, usually to 127 bytes
  // based on https://github.com/pnpm/cmd-shim
  // see also https://github.com/npm/cmd-shim
  // examples:
  // "#!/bin/sh" -> ["/bin/sh", ""]
  // "#! /usr/bin/bash a b c" -> ["/usr/bin/bash", " a b c"]
  // "#! /usr/bin/env -S bash a b c" -> ["bash", " a b c"]
  // "#! /usr/bin/env -Sbash a b c" -> ["bash", " a b c"]
  const shebangExpr = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S)?)?\s*(\S+)(.*)$/;
  let firstLineEnd = fileText.indexOf('\n');
  if (firstLineEnd == -1) firstLineEnd = fileText.length;
  const firstLine = fileText.slice(0, firstLineEnd).trimRight();
  const shebang = firstLine.match(shebangExpr);
  if (!shebang) return null;
  const [_, arg0, args] = shebang;
  return [arg0, args];
}

async function getDepgraph(packagePath, lockfilePath) {
  const depgraph = await parseNpmLockV2Project(
    read(packagePath),
    read(lockfilePath),
    {
      // devDependencies are required to build the root package from source
      includeDevDeps: true,

      strictOutOfSync: true,

      // only some optional deps have resolved+integrity values in lockfile
      // but some packages require optional deps
      // for example esbuild requires @esbuild/linux-x64
      // @esbuild/linux-x64 has resolved and integrity values in lockfile
      // and it has { "cpu": [ "x64" ], "os": [ "linux" ] }
      // so we install optional deps when
      // - they have resolved and integrity values
      // - their cpu and os values match with the target platform
      includeOptionalDeps: true,
    }
  );

  // we need depgraphData to get GraphNode deps
  // https://github.com/snyk/dep-graph/blob/master/src/core/types.ts
  const depgraphData = depgraph.toJSON();

  const depgraphNodesById = {};
  for (const node of depgraphData.graph.nodes) {
    depgraphNodesById[node.nodeId] = node;
  }

  depgraphData.nodesById = depgraphNodesById;

  // 遍历依赖图
  async function walk_depgraph(depgraphData, enter, _seen, depPath = []) {
    // 是否为根包
    const isRootPkg = depPath.length == 0

    // 获取当前包的节点
    const node = isRootPkg
      ? depgraphData.graph.nodes[0]
      : depgraphData.nodesById[depPath[depPath.length - 1].nameVersion]

    // 获取当前包的依赖信息
    const dep = isRootPkg ? {
      nameVersion: node.pkgId,
      name: node.pkgId.replace(/@[^@\/]*$/, ''),
      version: node.pkgId.replace(/^.*@/, ''),
      resolved: '',
      integrity: '',
    } : depPath[depPath.length - 1]

    // 如果当前包是根包，则将根包信息添加到依赖路径中
    if (isRootPkg) depPath[0] = dep;

    async function recurse() {
      // 获取当前包的依赖信息
      for (const {nodeId: childNodeId} of node.deps) {
        if (depPath.find(d => d.nameVersion == childNodeId)) {
          //enableDebug && debug(`found cycle in graph: ${depPath.map(d => d.nameVersion).join('  ')}  ${childNodeId}`)
          continue
        }

        // 获取当前包的版本
        const version = childNodeId.replace(/.*@/, '')
        // 获取当前包的名称
        const name = childNodeId.slice(0, -1*version.length - 1)
        // 获取当前包的依赖信息
        const node = depgraphData.nodesById[childNodeId]
        // 当前包的下载地址
        const resolved = node.info.labels.resolved
        // 当前包的校验值
        const integrity = node.info.labels.integrity
        // 组装版本包名字符串
        const childDep = {
          nameVersion: childNodeId,
          name,
          version,
          resolved,
          integrity,
        }
        // 遍历当前包的依赖信息
        await walk_depgraph(depgraphData, enter, _seen, depPath.concat([childDep]));
      }
    }

    await enter(dep, recurse, depPath);
  }

  return [
    depgraphData,
    walk_depgraph,
  ]
}

async function getDeptree(lockfilePath) {
  // https://github.com/snyk/nodejs-lockfile-parser/blob/master/lib/index.ts
  const deptree = await buildDepTree(
    read('package.json'),
    read(lockfilePath),
    true, // includeDev: devDependencies are required for build
    lockfileTypeOfName[path.basename(lockfilePath)],
    true, // strictOutOfSync
    // buildDepTree does not support optional deps
  );

  async function walk_deptree(_this, enter, _seen, depPath = []) {
    async function recurse() {
      for (let key in _this.dependencies) {
        if (depPath.find(d => d.name == key)) {
          //enableDebug && debug(`found cycle in tree: ${depPath.map(d => d.nameVersion).join('  ')}  ${key}`)
          continue
        }
        //enableDebug && debug(`no cycle in tree: ${depPath.map(d => d.nameVersion).join('  ')}  ${key}`)
        await walk_deptree(_this.dependencies[key], enter, _seen, depPath.concat([_this]));
      }
    }
    await enter(_this, recurse, depPath.concat([_this]));
  }

  return [
    deptree,
    walk_deptree,
  ]
}



const lockfileDefaultList = [ 'yarn.lock', 'package-lock.json' ];

const lockfileTypeOfName = {
  'package-lock.json': LockfileType.npm,
  'yarn.lock': LockfileType.yarn,
};



const TestPkgPath = './src/test_materials/package.json'
const TestPkgLockPath = './src/test_materials/package-lock.json'
const TestPkgMinimistTarPath = './src/test_materials/proxy-from-env-1.1.0.tgz'

async function main() {
  const pkg = json(TestPkgPath);
  const pkgLock = json(TestPkgLockPath);
  const pkgNameVersion = `${pkg.name}@${pkg.version}`;
  console.log(`${pkgNameVersion}: install NPM dependencies`)

  const [deps, walk_deps] = (
    pkgLock.lockfileVersion == 3 ? await getDepgraph(TestPkgPath, TestPkgLockPath) :
    pkgLock.lockfileVersion == 2 ? await getDepgraph(TestPkgPath, TestPkgLockPath) :
    pkgLock.lockfileVersion == 1 ? await getDeptree(TestPkgPath, TestPkgLockPath) :
    [null, null]
  )

  const store_dir = '.pnpm';
  const doneUnpack = new Set();
  const doneScripts = new Set();
  let numTicks = 0;
  const ticksPerLine = 50;
  const showTicks = false;

  async function enter(dep, recurse, depPath) {
    if (
      dep.version == '' &&
      dep.resolved == '' &&
      dep.nameVersion != 'package.json@' // v3
    ) {
      console.log(`${dep.name}: optional dependency was removed from lockfile`);
      return;
    }

    if (showTicks) {
      process.stdout.write('.'); // tick
      numTicks++;
      if (numTicks % ticksPerLine == 0) process.stdout.write('\n');
    }

    // TODO default false, use command line option
    const ignoreScripts = true;

    // 组装版本包名字符串
    dep.nameVersion = `${dep.name}@${dep.version}`;

    // dep is a "root dependency" = required by the root package
    // 是否是根依赖
    const isRootDep = (depPath.length == 2);
    isRootDep && console.log(`+ ${dep.nameVersion}`);

    // 是否是根包
    const isRootPkg = (depPath.length == 1);

    if (isRootPkg) {
      // 安装所有子包
      await recurse();

      // patch binaries in node_modules/.bin/
      // pnpm uses wrapper scripts, similar to nixpkgs wrapper scripts
      // nixpkgs would move the original binary (original-name) to .original-name.wrapped
      // fix: sh: line 1: /build/node_modules/.bin/patch-package: cannot execute: required file not found
      // fix: sh: line 1: /build/node_modules/.bin/husky: Permission denied
      const binNameList = fs.existsSync('node_modules/.bin') ? fs.readdirSync('node_modules/.bin') : [];

      (binNameList.length > 0) && console.log(`${dep.nameVersion}: patching binaries in node_modules/.bin/`);

      for (const binName of binNameList) {

        const binPath = `node_modules/.bin/${binName}`;
        console.log(`${dep.nameVersion}: patching binary ${binPath}`);

        // read the first 127 bytes of the old file
        // to parse the shebang line
        const shebangLineMaxLength = 127; // linux
        const fd = fs.openSync(binPath);
        const buf = new Buffer.alloc(shebangLineMaxLength);
        const readLength = fs.readSync(fd, buf, 0, shebangLineMaxLength, 0);
        fs.closeSync(fd);
        const fileText = buf.toString('utf8', 0, readLength);
        const shebang = parseShebang(fileText);

        const linkTarget = fs.readlinkSync(binPath);

        // create wrapper script
        // see also
        // https://github.com/pnpm/pnpm/issues/6937

        const linkTargetParts = linkTarget.split("/node_modules/");

        // const pkgStoreName = linkTargetParts[0].split("/")[2];
        const pkgStoreName = linkTargetParts[0].split("/")[1];

        // const pkgName = (linkTargetParts[1][0] == "@") ? linkTargetParts[1].split("/").slice(0, 2).join("/") : linkTargetParts[1].split("/")[0];
        const pkgName = pkgStoreName

        const linkTargetClean = linkTarget.replace(/\/(?:\.\/)+/g, "/"); // replace /./ with /

        // $b: absolute path to node_modules/.bin
        // $p: absolute path to node_modules/.pnpm
        // $n: absolute path to node_modules/.pnpm/${pkgStoreName}/node_modules
        const linkTargetShell = (
          // resolve parent path from $b to $n
          linkTargetClean.startsWith(`../.pnpm/${pkgStoreName}/node_modules/`) ? ("$n" + linkTargetClean.slice(`../.pnpm/${pkgStoreName}/node_modules`.length)) :
          // resolve parent path from $b to $p
          linkTargetClean.startsWith("../.pnpm/") ? ("$p" + linkTargetClean.slice(8)) :
          // keep absolute path
          linkTargetClean.startsWith("/") ? linkTargetClean :
          // use relative path to $b
          ("$b/" + linkTargetClean)
        );

        const linkTargetShellDir = linkTargetShell.replace(/\/[^/]+$/, '');

        const wrapperScriptLines = [
          '#!/bin/sh',
          '',
          'set -e',
          '',
          'b="$(readlink -f "$(dirname "$0")")"', // absolute path of node_modules/.bin
          'p="$(dirname "$b")/.pnpm"', // absolute path of node_modules/.pnpm
          `n="$p/${pkgStoreName}/node_modules"`,
          '',
          [
            'export NODE_PATH="',
            ...(
              // example:
              // linkTargetShellDir = "$n/somepkg/dist/bin"
              // -> add paths:
              // "$n/somepkg/dist/bin/node_modules"
              // "$n/somepkg/dist/node_modules"
              linkTargetShellDir.startsWith(`$n/${pkgName}/`)
              ? (
                linkTargetShellDir.slice(`$n/${pkgName}/`.length).split('/').map(
                  (_val, idx, arr) => `$n/${pkgName}/${arr.slice(0, arr.length - idx).join('/')}/node_modules:`
                )
              )
              : []
            ),
            `$n/${pkgName}/node_modules:`,
            `$n:`,
            '$p/node_modules:',
            '$NODE_PATH"',
          ].join('\\\n'),
          '',

          //`# debug`,
          //`echo "0: $0"`,
          //`echo "b: $b"`,
          //`echo "p: $p"`,
          //`echo "a: $a"`,
          //`echo "NODE_PATH: $NODE_PATH"`,
        ];

        if (!shebang) {
          // no shebang. just exec the file with custom NODE_PATH
          wrapperScriptLines.push(`exec "${linkTargetShell}" "$@"`);
        }
        else {
          const [arg0, args] = shebang;
          if (arg0[0] == '/') {
            // absolute path to the arg0 executable
            wrapperScriptLines.push(`exec ${arg0}${args} "${linkTargetShell}" "$@"`);
          }
          else {
            // executable name via "/usr/bin/env" or "/usr/bin/env -S"
            const arg0Name = arg0;
            // get absolute path of the arg0 executable
            // this throws when arg0Name is not in $PATH
            const arg0Path = await which(arg0Name);
            wrapperScriptLines.push(
              `[ -x "$b/${arg0}" ] &&`,
              `exec "$b/${arg0}" "${linkTargetShell}" "$@"`,
              '',

              // no. this is handled by nodejs-hide-symlinks
              // with a node wrapper in $PATH
              //...(arg0 == 'node' ? [
              //  `LD_PRELOAD=/nix/store/i2wh1abgq9wqsxgpsjgydfhf9n54f06f-nodejs-hide-symlinks-unstable-2021-09-29/lib/libnodejs_hide_symlinks.so \\`,
              //] : []),

              // abolute path to node binary?
              // no. the build environment's $PATH should have these binaries
              // for the runtime environment, the user can generate extra wrapper scripts
              // yes. in the nix store, all calls to binaries should use absolute paths.
              //`exec ${arg0} "${linkTargetShell}" "$@"`,
              `exec "${arg0Path}" "${linkTargetShell}" "$@"`,
            );
          }
        }

        // replace the symlink in node_modules/.bin with a wrapper script
        fs.unlinkSync(binPath);
        const wrapperScript = wrapperScriptLines.join('\n') + '\n';
        fs.writeFileSync(binPath, wrapperScript, 'utf8');
        chmod(binPath, 0o755);
      }

      // run lifecycle scripts of root package
      // pkg is the parsed package.json
      if (ignoreScripts == false && pkg.scripts) {
        console.log(`${dep.nameVersion}: running lifecycle scripts`)
        for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          if (!(scriptName in pkg.scripts)) continue;
          console.log(`> ${pkgNameVersion} ${scriptName}: ${pkg.scripts[scriptName]}`)
          spawn(['npm', 'run', scriptName]);
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      // root package: nothing to unpack.
      // dependencies were installed in recurse
      return;
    }

    // pkg is root dependency or nested dependency
    // isRootPkg == false

    const parent = isRootDep ? null : depPath[depPath.length - 2];

    if (parent) {
      parent.nameVersion = `${parent.name}@${parent.version}`;
      parent.nameVersionStore = parent.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm
    }

    // nameVersionStore: in the first level of store_dir, all names are escaped
    dep.nameVersionStore = dep.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm

    const dep_path = isRootDep
      // create link node_modules/x with target node_modules/.pnpm/x@1/node_modules/x
      ? `node_modules/${dep.name}`
      // create link node_modules/.pnpm/parent@1/node_modules/x with target ../../x@1/node_modules/x
      : `node_modules/${store_dir}/${parent.nameVersionStore}/node_modules/${dep.name}`

    dep.nameEscaped = dep.name.replace(/[/]/g, '+'); // escape / with + like pnpm

    const dep_target = (dep.name.includes('/') ? '../' : '') + (isRootDep
      // create link node_modules/x with target node_modules/.pnpm/x@1/node_modules/x
      ? `${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      // create link node_modules/.pnpm/parent@1/node_modules/x with target ../../x@1/node_modules/x
      : `../../${dep.nameVersionStore}/node_modules/${dep.name}`
    );

    const dep_store = `node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`;

    // dep.resolved is tarfile or directory
    if (dep.resolved.startsWith("file://")) {
      // dep.resolved is tarfile -> unpack
      const tgzpath = dep.resolved.replace(/^file:\/\//, '');
      if (tgzpath[0] != '/' ) {
        throw new Error(`invalid tarfile path '${tgzpath}' - expected file:///*.tgz`)
      }
      unpack(tgzpath, dep_store);
    } else {
      // dep.resolved is directory -> create symlink
      if (dep.resolved[0] != '/' ) {
        // throw new Error(`invalid directory path '${dep.resolved}' - expected /*`);
        if (dep.resolved === 'https://mirrors.tencent.com/npm/proxy-from-env/-/proxy-from-env-1.1.0.tgz') {
          unpack(TestPkgMinimistTarPath, dep_target);
        }
      }

      // create link from machine-level store to local .pnpm/ store
      if (!fs.existsSync(dep_store)) {
        // symlink(dep.resolved, dep_store);
        if (dep.resolved === 'https://mirrors.tencent.com/npm/proxy-from-env/-/proxy-from-env-1.1.0.tgz') {
          if (!fs.lstatSync(dep_store).isSymbolicLink) {
            symlink(dep_target, dep_store);
          }
        }
      }
    }
    // 加入到已解压包集合中
    doneUnpack.add(dep.nameVersion);

    // install nested dep
    if (!fs.existsSync(dep_path)) {
      // symlink(dep_target, dep_path);
      if (!fs.lstatSync(dep_path).isSymbolicLink) {
        symlink(dep_store, dep_path);
      }
    } else {
      // symlink exists
      const old_target = fs.readlinkSync(dep_path);
      if (old_target != dep_target) {
        throw new Error([
          `ERROR symlink collision`,
          `old symlink: ${dep_path} -> ${old_target}`,
          `new symlink: ${dep_path} -> ${dep_target}`,
        ].join('\n'));
      }
    }

    if (isRootDep) {
      // install binaries. for this we must read the dep's package.json
      // const dep_store_rel = `../${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      const dep_store_rel = `${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      // const pkg = json(`${dep_store}/package.json`);
      const pkg = json(`${dep_target}/package.json`);
      const deep_dir = `node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`;

      if (typeof pkg.bin == 'string') {
        const linkPath = `node_modules/.bin/${dep.name}`;
        const linkTarget = `${dep_store_rel}/${pkg.bin}`;
        if (!fs.existsSync(linkPath)) {
          symlink(linkTarget, linkPath);
        }
        else {
          // collision: symlink exists
          const old_target = fs.readlinkSync(linkPath);
          if (old_target != linkTarget) {
            // short path: ../.pnpm/@playwright+test@1.28.1/node_modules/@playwright/test/./cli.js -> @playwright/test/./cli.js
            const s = str => str.split("/").slice(4).join("/");
            // TODO collect these warnings and show them again at the end
            console.log(`WARNING: collision on ${linkPath}: preferring ${s(old_target)} over ${s(linkTarget)}. use (TODO implement) to change this`);
          }
        }
      }
      else if (typeof pkg.bin == 'object') {
        for (const binName of Object.keys(pkg.bin)) {
          const linkPath = `node_modules/.bin/${binName}`;
          const linkTarget = `${dep_store_rel}/${pkg.bin[binName]}`
          if (!fs.existsSync(linkPath)) {
            symlink(linkTarget, linkPath);
          }
          else {
            // collision: symlink exists
            const old_target = fs.readlinkSync(linkPath);
            if (old_target != linkTarget) {
              const s = str => str.split("/").slice(4).join("/");
              // TODO collect these warnings and show them again at the end
              console.log(`WARNING: collision on ${linkPath}: preferring ${s(old_target)} over ${s(linkTarget)}. use (TODO implement) to change this`);
            }
          }
        }
      }
    }

    // install child deps
    await recurse();

    // FIXME read preInstallLinks from file
    //console.dir({ loc: 390, preInstallLinks });
    /*
    暂时注释
    if (preInstallLinks != null && dep.name in preInstallLinks) {
      // symlink files from /nix/store
      for (const linkPath in preInstallLinks[dep.name]) {
        const linkTarget = preInstallLinks[dep.name][linkPath];
        console.log(`> ${dep.name}@${dep.version}: add symlink from preInstallLinks: ${linkPath} -> ${linkTarget}`)
        if (fs.existsSync(`${dep_store}/${linkPath}`)) {
          console.log(`> remove existing file ${dep_store}/${linkPath}`)
          fs.unlinkSync(`${dep_store}/${linkPath}`); // TODO also 'rm -rf' directories
        }
        try {
          symlink(linkTarget, `${dep_store}/${linkPath}`);
        }
        catch (error) {
          // TODO handle collisions
          throw error;
        }
      }
    }
    */

    // run lifecycle scripts of dependency
    // run scripts after recurse, so that child-dependencies are installed
    if (doneScripts.has(dep.nameVersion)) {
      console.log(`already done scripts: ${dep.name}@${dep.version}`);
    } else {
      // const dep_pkg = json(`${dep_store}/package.json`);
      const dep_pkg = json(`${dep_target}/package.json`);
      if (ignoreScripts == false && dep_pkg.scripts) {
        for (const scriptName of ['preinstall', 'install', 'postinstall']) {
          if (!(scriptName in dep_pkg.scripts)) {
            continue;
          }
          console.log(`> ${pkgNameVersion} ${scriptName}: ${dep_pkg.scripts[scriptName]}`)

          const workdir = process.cwd();

          const NODE_PATH = [
            // TODO add paths, see linkTargetShellDir.slice
            `${workdir}/node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}/node_modules`,
            `${workdir}/node_modules/${store_dir}/${dep.nameVersionStore}/node_modules`,
            `${workdir}/node_modules`,
            (process.env.NODE_PATH || ''),
          ].join(':');

          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
          const spawnResult = spawn(['npm', 'run', scriptName], {
            cwd: dep_store,
            env: {
              ...process.env,
              NODE_PATH,
            }
          });
          if (spawnResult.status > 0) {
            throw new Error(`ERROR in ${pkgNameVersion} ${scriptName}`)
          }
        }
      }
      doneScripts.add(dep.nameVersion);
    }
  }

  await walk_deps(deps, enter);

  // summary
  if (showTicks) process.stdout.write('\n'); // newline after ticks
  const deltaTime = (Date.now() - startTime) / 1000;
  console.log(`${pkgNameVersion}: installed ${doneUnpack.size} node modules in ${deltaTime.toFixed(2)} seconds`)
}

main();
