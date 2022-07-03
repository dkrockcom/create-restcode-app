'use strict';
const http = require('http');
const https = require('https');
const chalk = require('chalk');
const commander = require('commander');
const dns = require('dns');
const execSync = require('child_process').execSync;
const fs = require('fs-extra');
const hyperquest = require('hyperquest');
const os = require('os');
const path = require('path');
const semver = require('semver');
const spawn = require('cross-spawn');
const tmp = require('tmp');
const unpack = require('tar-pack').unpack;
const url = require('url');
const validateProjectName = require('validate-npm-package-name');

const request = require('request');
const _cliProgress = require('cli-progress');
const extract = require('extract-zip');

const packageJson = require('./package.json');

function isUsingYarn() {
    return (process.env.npm_config_user_agent || '').indexOf('yarn') === 0;
}

let projectName;


const download = (url, filename) => {
    return new Promise((res) => {
        const progressBar = new _cliProgress.SingleBar({
            format: '{bar} {percentage}% | ETA: {eta}s'
        }, _cliProgress.Presets.shades_classic);

        const file = fs.createWriteStream(filename);
        let receivedBytes = 0

        request.get(url)
            .on('response', (response) => {
                if (response.statusCode !== 200) {
                    return res('Response status was ' + response.statusCode);
                }

                const totalBytes = response.headers['content-length'];
                progressBar.start(totalBytes, 0);
            })
            .on('data', (chunk) => {
                receivedBytes += chunk.length;
                progressBar.update(receivedBytes);
            })
            .pipe(file)
            .on('error', (err) => {
                fs.unlink(filename);
                progressBar.stop();
                return res(err.message);
            });

        file.on('finish', () => {
            progressBar.stop();
            file.close(res);
        });

        file.on('error', (err) => {
            fs.unlink(filename);
            progressBar.stop();
            return res(err.message);
        });
    })
};


function init() {
    const program = new commander.Command(packageJson.name)
        .version(packageJson.version)
        .arguments('<project-directory>')
        .usage(`${chalk.green('<project-directory>')} [options]`)
        .action(name => {
            projectName = name;
        })
        .option('--verbose', 'print additional logs')
        .option('--info', 'print environment debug info')
        .option('--use-pnp')
        .allowUnknownOption()
        .on('--help', () => {
            console.log(
                `    Only ${chalk.green('<project-directory>')} is required.`
            );
            console.log(`      - a specific npm version: ${chalk.green('0.8.2')}`);
            console.log(`      - a specific npm tag: ${chalk.green('@next')}`);
            console.log(
                `    It is not needed unless you specifically want to use a fork.`
            );
            console.log();
            console.log(
                `    If you have any problems, do not hesitate to file an issue:`
            );
            console.log(
                `      ${chalk.cyan(
                    'https://github.com/facebook/create-restcode-app/issues/new'
                )}`
            );
            console.log();
        }).parse(process.argv);

    if (typeof projectName === 'undefined') {
        console.error('Please specify the project directory:');
        console.log(
            `  ${chalk.cyan(program.name())} ${chalk.green('<project-directory>')}`
        );
        console.log();
        console.log('For example:');
        console.log(
            `  ${chalk.cyan(program.name())} ${chalk.green('my-restcode-app')}`
        );
        console.log();
        console.log(
            `Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`
        );
        process.exit(1);
    }

    // We first check the registry directly via the API, and if that fails, we try
    // the slower `npm view [package] version` command.
    //
    // This is important for users in environments where direct access to npm is
    // blocked by a firewall, and packages are provided exclusively via a private
    // registry.
    checkForLatestVersion()
        .catch(() => {
            try {
                return execSync('npm view create-restcode-app version').toString().trim();
            } catch (e) {
                return null;
            }
        })
        .then(latest => {
            if (latest && semver.lt(packageJson.version, latest)) {
                console.log();
                console.error(
                    chalk.yellow(
                        `You are running \`create-restcode-app\` ${packageJson.version}, which is behind the latest release (${latest}).\n\n` +
                        'We recommend always using the latest version of create-restcode-app if possible.'
                    )
                );
                console.log();
                console.log(
                    'The latest instructions for creating a new app can be found here:\n' +
                    'https://create-restcode-app.dev/docs/getting-started/'
                );
                console.log();
            } else {
                const useYarn = isUsingYarn();
                createApp(
                    projectName,
                    program.verbose,
                    program.scriptsVersion,
                    program.template,
                    useYarn,
                    program.usePnp
                );
            }
        });
}

function createApp(name, verbose, version, template, useYarn, usePnp) {
    const root = path.resolve(name);
    const appName = path.basename(root);

    checkAppName(appName);
    fs.ensureDirSync(name);
    if (!isSafeToCreateProjectIn(root, name)) {
        process.exit(1);
    }
    console.log();

    console.log(`Creating a new restcode app in ${chalk.green(root)}.`);
    console.log();

    const packageJson = {
        "name": appName,
        "version": '0.1.0',
        "description": "Restcode App",
        "main": "index.js",
        "scripts": {
            "start": "index.js"
        },
        "keywords": [
            "node",
            "express",
            "mongoose",
            "mongoDB",
            "ejs",
            "restcode framework"
        ],
        "author": "codehuntz",
        "license": "MIT"
    }

    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify(packageJson, null, 2) + os.EOL
    );

    const originalDirectory = process.cwd();
    process.chdir(root);
    if (!useYarn && !checkThatNpmCanReadCwd()) {
        process.exit(1);
    }

    if (!useYarn) {
        const npmInfo = checkNpmVersion();
        if (!npmInfo.hasMinNpm) {
            if (npmInfo.npmVersion) {
                console.log(
                    chalk.yellow(
                        `You are using npm ${npmInfo.npmVersion} so the project will be bootstrapped with an old unsupported version of tools.\n\n` +
                        `Please update to npm 6 or higher for a better, fully supported experience.\n`
                    )
                );
            }
        }
    } else if (usePnp) {
        const yarnInfo = checkYarnVersion();
        if (yarnInfo.yarnVersion) {
            if (!yarnInfo.hasMinYarnPnp) {
                console.log(
                    chalk.yellow(
                        `You are using Yarn ${yarnInfo.yarnVersion} together with the --use-pnp flag, but Plug'n'Play is only supported starting from the 1.12 release.\n\n` +
                        `Please update to Yarn 1.12 or higher for a better, fully supported experience.\n`
                    )
                );
                // 1.11 had an issue with webpack-dev-middleware, so better not use PnP with it (never reached stable, but still)
                usePnp = false;
            }
            if (!yarnInfo.hasMaxYarnPnp) {
                console.log(
                    chalk.yellow(
                        'The --use-pnp flag is no longer necessary with yarn 2 and will be deprecated and removed in a future release.\n'
                    )
                );
                // 2 supports PnP by default and breaks when trying to use the flag
                usePnp = false;
            }
        }
    }

    run(
        root,
        appName,
        version,
        verbose,
        originalDirectory,
        template,
        useYarn,
        usePnp
    );
}

function install(root, useYarn, usePnp, dependencies, verbose, isOnline) {
    return new Promise((resolve, reject) => {
        let command;
        let args;
        if (useYarn) {
            command = 'yarnpkg';
            args = ['add', '--exact'];
            if (!isOnline) {
                args.push('--offline');
            }
            if (usePnp) {
                args.push('--enable-pnp');
            }
            [].push.apply(args, dependencies);

            // Explicitly set cwd() to work around issues like
            // https://github.com/facebook/create-restcode-app/issues/3326.
            // Unfortunately we can only do this for Yarn because npm support for
            // equivalent --prefix flag doesn't help with this issue.
            // This is why for npm, we run checkThatNpmCanReadCwd() early instead.
            args.push('--cwd');
            args.push(root);

            if (!isOnline) {
                console.log(chalk.yellow('You appear to be offline.'));
                console.log(chalk.yellow('Falling back to the local Yarn cache.'));
                console.log();
            }
        } else {
            command = 'npm';
            args = [
                'install',
                '--no-audit', // https://github.com/facebook/create-restcode-app/issues/11174
                '--save',
                '--save-exact',
                '--loglevel',
                'error',
            ].concat(dependencies);

            if (usePnp) {
                console.log(chalk.yellow("NPM doesn't support PnP."));
                console.log(chalk.yellow('Falling back to the regular installs.'));
                console.log();
            }
        }

        if (verbose) {
            args.push('--verbose');
        }

        const child = spawn(command, args, { stdio: 'inherit' });
        child.on('close', code => {
            if (code !== 0) {
                reject({
                    command: `${command} ${args.join(' ')}`,
                });
                return;
            }
            resolve();
        });
    });
}

function run(
    root,
    appName,
    version,
    verbose,
    originalDirectory,
    template,
    useYarn,
    usePnp
) {
    Promise.all([
        getInstallPackage(version, originalDirectory),
    ]).then(([packageToInstall]) => {
        const allDependencies = [packageToInstall];
        console.log('Installing packages. This might take a couple of minutes.');

        Promise.all([
            getPackageInfo(packageToInstall),
        ]).then(([packageInfo]) =>
            checkIfOnline(useYarn).then(isOnline => ({
                isOnline,
                packageInfo
            }))
        ).then(({ isOnline, packageInfo }) => {
            console.log(
                `Installing ${chalk.cyan('rest-code')}`
            );
            console.log();
            return install(
                root,
                useYarn,
                usePnp,
                allDependencies,
                verbose,
                isOnline
            ).then(() => ({
                packageInfo
            }));
        }).then(async ({ packageInfo }) => {
            const packageName = packageInfo.name;
            checkNodeVersion(packageName);
            setCaretRangeForRuntimeDeps(packageName);

            const pnpPath = path.resolve(process.cwd(), '.pnp.js');
            const nodeArgs = fs.existsSync(pnpPath) ? ['--require', pnpPath] : [];

            const templatePath = path.join(root, "template.zip");
            await download("https://github.com/dkrockcom/restcode-app-template/archive/refs/heads/master.zip", templatePath);
            await extract(templatePath, { dir: root });

            const templateSourcePath = path.join(root, "restcode-app-template-master");
            fs.copySync(templateSourcePath, root, { recursive: true, force: true });
            fs.removeSync(templateSourcePath, { recursive: true, force: true });
            fs.removeSync(templatePath, { recursive: true, force: true });

            console.log('App Created');
        }).catch(reason => {
            console.log();
            console.log('Aborting installation.');
            if (reason.command) {
                console.log(`  ${chalk.cyan(reason.command)} has failed.`);
            } else {
                console.log(
                    chalk.red('Unexpected error. Please report it as a bug:')
                );
                console.log(reason);
            }
            console.log();

            // On 'exit' we will delete these files from target directory.
            const knownGeneratedFiles = ['package.json', 'node_modules'];
            const currentFiles = fs.readdirSync(path.join(root));
            currentFiles.forEach(file => {
                knownGeneratedFiles.forEach(fileToMatch => {
                    // This removes all knownGeneratedFiles.
                    if (file === fileToMatch) {
                        console.log(`Deleting generated file... ${chalk.cyan(file)}`);
                        fs.removeSync(path.join(root, file));
                    }
                });
            });
            const remainingFiles = fs.readdirSync(path.join(root));
            if (!remainingFiles.length) {
                // Delete target folder if empty
                console.log(
                    `Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(
                        path.resolve(root, '..')
                    )}`
                );
                process.chdir(path.resolve(root, '..'));
                fs.removeSync(path.join(root));
            }
            console.log('Done.');
            process.exit(1);
        });
    });
}

function getInstallPackage(version, originalDirectory) {
    let packageToInstall = 'rest-code';
    const validSemver = semver.valid(version);
    if (validSemver) {
        packageToInstall += `@${validSemver}`;
    } else if (version) {
        if (version[0] === '@' && !version.includes('/')) {
            packageToInstall += version;
        } else if (version.match(/^file:/)) {
            packageToInstall = `file:${path.resolve(
                originalDirectory,
                version.match(/^file:(.*)?$/)[1]
            )}`;
        } else {
            // for tar.gz or alternative paths
            packageToInstall = version;
        }
    }

    return Promise.resolve(packageToInstall);
}

function getTemporaryDirectory() {
    return new Promise((resolve, reject) => {
        // Unsafe cleanup lets us recursively delete the directory if it contains
        // contents; by default it only allows removal if it's empty
        tmp.dir({ unsafeCleanup: true }, (err, tmpdir, callback) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    tmpdir: tmpdir,
                    cleanup: () => {
                        try {
                            callback();
                        } catch (ignored) {
                            // Callback might throw and fail, since it's a temp directory the
                            // OS will clean it up eventually...
                        }
                    },
                });
            }
        });
    });
}

function extractStream(stream, dest) {
    return new Promise((resolve, reject) => {
        stream.pipe(
            unpack(dest, err => {
                if (err) {
                    reject(err);
                } else {
                    resolve(dest);
                }
            })
        );
    });
}

// Extract package name from tarball url or path.
function getPackageInfo(installPackage) {
    if (installPackage.match(/^.+\.(tgz|tar\.gz)$/)) {
        return getTemporaryDirectory()
            .then(obj => {
                let stream;
                if (/^http/.test(installPackage)) {
                    stream = hyperquest(installPackage);
                } else {
                    stream = fs.createReadStream(installPackage);
                }
                return extractStream(stream, obj.tmpdir).then(() => obj);
            })
            .then(obj => {
                const { name, version } = require(path.join(
                    obj.tmpdir,
                    'package.json'
                ));
                obj.cleanup();
                return { name, version };
            })
            .catch(err => {
                console.log(
                    `Could not extract the package name from the archive: ${err.message}`
                );
                const assumedProjectName = installPackage.match(
                    /^.+\/(.+?)(?:-\d+.+)?\.(tgz|tar\.gz)$/
                )[1];
                console.log(
                    `Based on the filename, assuming it is "${chalk.cyan(
                        assumedProjectName
                    )}"`
                );
                return Promise.resolve({ name: assumedProjectName });
            });
    } else if (installPackage.startsWith('git+')) {
        // Pull package name out of git urls e.g:
        return Promise.resolve({
            name: installPackage.match(/([^/]+)\.git(#.*)?$/)[1],
        });
    } else if (installPackage.match(/.+@/)) {
        // Do not match @scope/ when stripping off @version or @tag
        return Promise.resolve({
            name: installPackage.charAt(0) + installPackage.substr(1).split('@')[0],
            version: installPackage.split('@')[1],
        });
    } else if (installPackage.match(/^file:/)) {
        const installPackagePath = installPackage.match(/^file:(.*)?$/)[1];
        const { name, version } = require(path.join(
            installPackagePath,
            'package.json'
        ));
        return Promise.resolve({ name, version });
    }
    return Promise.resolve({ name: installPackage });
}

function checkNpmVersion() {
    let hasMinNpm = false;
    let npmVersion = null;
    try {
        npmVersion = execSync('npm --version').toString().trim();
        hasMinNpm = semver.gte(npmVersion, '6.0.0');
    } catch (err) {
        // ignore
    }
    return {
        hasMinNpm: hasMinNpm,
        npmVersion: npmVersion,
    };
}

function checkYarnVersion() {
    const minYarnPnp = '1.12.0';
    const maxYarnPnp = '2.0.0';
    let hasMinYarnPnp = false;
    let hasMaxYarnPnp = false;
    let yarnVersion = null;
    try {
        yarnVersion = execSync('yarnpkg --version').toString().trim();
        if (semver.valid(yarnVersion)) {
            hasMinYarnPnp = semver.gte(yarnVersion, minYarnPnp);
            hasMaxYarnPnp = semver.lt(yarnVersion, maxYarnPnp);
        } else {
            // Handle non-semver compliant yarn version strings, which yarn currently
            // uses for nightly builds. The regex truncates anything after the first
            // dash. See #5362.
            const trimmedYarnVersionMatch = /^(.+?)[-+].+$/.exec(yarnVersion);
            if (trimmedYarnVersionMatch) {
                const trimmedYarnVersion = trimmedYarnVersionMatch.pop();
                hasMinYarnPnp = semver.gte(trimmedYarnVersion, minYarnPnp);
                hasMaxYarnPnp = semver.lt(trimmedYarnVersion, maxYarnPnp);
            }
        }
    } catch (err) {
        // ignore
    }
    return {
        hasMinYarnPnp: hasMinYarnPnp,
        hasMaxYarnPnp: hasMaxYarnPnp,
        yarnVersion: yarnVersion,
    };
}

function checkNodeVersion(packageName) {
    const packageJsonPath = path.resolve(
        process.cwd(),
        'node_modules',
        packageName,
        'package.json'
    );

    if (!fs.existsSync(packageJsonPath)) {
        return;
    }

    const packageJson = require(packageJsonPath);
    if (!packageJson.engines || !packageJson.engines.node) {
        return;
    }

    if (!semver.satisfies(process.version, packageJson.engines.node)) {
        console.error(
            chalk.red(
                'You are running Node %s.\n' +
                'Create Restcode App requires Node %s or higher. \n' +
                'Please update your version of Node.'
            ),
            process.version,
            packageJson.engines.node
        );
        process.exit(1);
    }
}

function checkAppName(appName) {
    const validationResult = validateProjectName(appName);
    if (!validationResult.validForNewPackages) {
        console.error(
            chalk.red(
                `Cannot create a project named ${chalk.green(
                    `"${appName}"`
                )} because of npm naming restrictions:\n`
            )
        );
        [
            ...(validationResult.errors || []),
            ...(validationResult.warnings || []),
        ].forEach(error => {
            console.error(chalk.red(`  * ${error}`));
        });
        console.error(chalk.red('\nPlease choose a different project name.'));
        process.exit(1);
    }

    // TODO: there should be a single place that holds the dependencies
    const dependencies = ['rest-code'].sort();
    if (dependencies.includes(appName)) {
        console.error(
            chalk.red(
                `Cannot create a project named ${chalk.green(
                    `"${appName}"`
                )} because a dependency with the same name exists.\n` +
                `Due to the way npm works, the following names are not allowed:\n\n`
            ) +
            chalk.cyan(dependencies.map(depName => `  ${depName}`).join('\n')) +
            chalk.red('\n\nPlease choose a different project name.')
        );
        process.exit(1);
    }
}

function setCaretRangeForRuntimeDeps(packageName) {
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = require(packagePath);

    if (typeof packageJson.dependencies === 'undefined') {
        console.error(chalk.red('Missing dependencies in package.json'));
        process.exit(1);
    }

    const packageVersion = packageJson.dependencies[packageName];
    if (typeof packageVersion === 'undefined') {
        console.error(chalk.red(`Unable to find ${packageName} in package.json`));
        process.exit(1);
    }

    //makeCaretRange(packageJson.dependencies, 'rest-code');

    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + os.EOL);
}

// If project only contains files generated by GH, it’s safe.
// Also, if project contains remnant error logs from a previous
// installation, lets remove them now.
// We also special case IJ-based products .idea because it integrates with CRA:
// https://github.com/facebook/create-restcode-app/pull/368#issuecomment-243446094
function isSafeToCreateProjectIn(root, name) {
    const validFiles = [
        '.DS_Store',
        '.git',
        '.gitattributes',
        '.gitignore',
        '.gitlab-ci.yml',
        '.hg',
        '.hgcheck',
        '.hgignore',
        '.idea',
        '.npmignore',
        '.travis.yml',
        'docs',
        'LICENSE',
        'README.md',
        'mkdocs.yml',
        'Thumbs.db',
    ];
    // These files should be allowed to remain on a failed install, but then
    // silently removed during the next create.
    const errorLogFilePatterns = [
        'npm-debug.log',
        'yarn-error.log',
        'yarn-debug.log',
    ];
    const isErrorLog = file => {
        return errorLogFilePatterns.some(pattern => file.startsWith(pattern));
    };

    const conflicts = fs
        .readdirSync(root)
        .filter(file => !validFiles.includes(file))
        // IntelliJ IDEA creates module files before CRA is launched
        .filter(file => !/\.iml$/.test(file))
        // Don't treat log files from previous installation as conflicts
        .filter(file => !isErrorLog(file));

    if (conflicts.length > 0) {
        console.log(
            `The directory ${chalk.green(name)} contains files that could conflict:`
        );
        console.log();
        for (const file of conflicts) {
            try {
                const stats = fs.lstatSync(path.join(root, file));
                if (stats.isDirectory()) {
                    console.log(`  ${chalk.blue(`${file}/`)}`);
                } else {
                    console.log(`  ${file}`);
                }
            } catch (e) {
                console.log(`  ${file}`);
            }
        }
        console.log();
        console.log(
            'Either try using a new directory name, or remove the files listed above.'
        );

        return false;
    }

    // Remove any log files from a previous installation.
    fs.readdirSync(root).forEach(file => {
        if (isErrorLog(file)) {
            fs.removeSync(path.join(root, file));
        }
    });
    return true;
}

function getProxy() {
    if (process.env.https_proxy) {
        return process.env.https_proxy;
    } else {
        try {
            // Trying to read https-proxy from .npmrc
            let httpsProxy = execSync('npm config get https-proxy').toString().trim();
            return httpsProxy !== 'null' ? httpsProxy : undefined;
        } catch (e) {
            return;
        }
    }
}

// See https://github.com/facebook/create-restcode-app/pull/3355
function checkThatNpmCanReadCwd() {
    const cwd = process.cwd();
    let childOutput = null;
    try {
        // Note: intentionally using spawn over exec since
        // the problem doesn't reproduce otherwise.
        // `npm config list` is the only reliable way I could find
        // to reproduce the wrong path. Just printing process.cwd()
        // in a Node process was not enough.
        childOutput = spawn.sync('npm', ['config', 'list']).output.join('');
    } catch (err) {
        // Something went wrong spawning node.
        // Not great, but it means we can't do this check.
        // We might fail later on, but let's continue.
        return true;
    }
    if (typeof childOutput !== 'string') {
        return true;
    }
    const lines = childOutput.split('\n');
    // `npm config list` output includes the following line:
    // "; cwd = C:\path\to\current\dir" (unquoted)
    // I couldn't find an easier way to get it.
    const prefix = '; cwd = ';
    const line = lines.find(line => line.startsWith(prefix));
    if (typeof line !== 'string') {
        // Fail gracefully. They could remove it.
        return true;
    }
    const npmCWD = line.substring(prefix.length);
    if (npmCWD === cwd) {
        return true;
    }
    console.error(
        chalk.red(
            `Could not start an npm process in the right directory.\n\n` +
            `The current directory is: ${chalk.bold(cwd)}\n` +
            `However, a newly started npm process runs in: ${chalk.bold(
                npmCWD
            )}\n\n` +
            `This is probably caused by a misconfigured system terminal shell.`
        )
    );
    if (process.platform === 'win32') {
        console.error(
            chalk.red(`On Windows, this can usually be fixed by running:\n\n`) +
            `  ${chalk.cyan(
                'reg'
            )} delete "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n` +
            `  ${chalk.cyan(
                'reg'
            )} delete "HKLM\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n\n` +
            chalk.red(`Try to run the above two lines in the terminal.\n`) +
            chalk.red(
                `To learn more about this problem, read: https://blogs.msdn.microsoft.com/oldnewthing/20071121-00/?p=24433/`
            )
        );
    }
    return false;
}

function checkIfOnline(useYarn) {
    if (!useYarn) {
        // Don't ping the Yarn registry.
        // We'll just assume the best case.
        return Promise.resolve(true);
    }

    return new Promise(resolve => {
        dns.lookup('registry.yarnpkg.com', err => {
            let proxy;
            if (err != null && (proxy = getProxy())) {
                // If a proxy is defined, we likely can't resolve external hostnames.
                // Try to resolve the proxy name as an indication of a connection.
                dns.lookup(url.parse(proxy).hostname, proxyErr => {
                    resolve(proxyErr == null);
                });
            } else {
                resolve(err == null);
            }
        });
    });
}

function executeNodeScript({ cwd, args }, data, source) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [...args, '-e', source, '--', JSON.stringify(data)],
            { cwd, stdio: 'inherit' }
        );

        child.on('close', code => {
            if (code !== 0) {
                reject({
                    command: `node ${args.join(' ')}`,
                });
                return;
            }
            resolve();
        });
    });
}

function checkForLatestVersion() {
    return new Promise((resolve, reject) => {
        https
            .get(
                'https://registry.npmjs.org/-/package/create-restcode-app/dist-tags',
                res => {
                    if (res.statusCode === 200) {
                        let body = '';
                        res.on('data', data => (body += data));
                        res.on('end', () => {
                            resolve(JSON.parse(body).latest);
                        });
                    } else {
                        reject();
                    }
                }
            )
            .on('error', () => {
                reject();
            });
    });
}

module.exports = {
    init
};