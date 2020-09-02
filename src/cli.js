import inquirer from 'inquirer';
import {cwd} from 'process';
import tar from 'tar';
import crypto from 'crypto';
import fs from 'fs';
import AWS from 'aws-sdk';
import path from 'path';
import mime from 'mime-types';
import keytar from 'keytar';
import yargs from 'yargs';
import slash from 'slash';
import aws4 from 'aws4';
import axios from 'axios';
import chalk from 'chalk';

const log = console.log;
const error = console.error;
const {blue, green, gray, red} = chalk;

function parseArgumentsIntoOptions() {
  return yargs
    .usage('Usage: hcs <command> [options]')
    .command('build', 'Create a tar.gz file for the app', (yargs) => {
      return yargs.option('latest', {
        type: 'boolean',
        description: 'Version will be replaced by \'latest\' instead of what is in the app.json. Do NOT use this unless you know what you are doing!'
      })
    }, build)
    .command('publish', 'Build the app and upload it to the Homey Community Store', (yargs) => {
      return yargs.option('force', {
        type: 'boolean',
        description: 'CAUTION: This will override the version if it already exists in the database!'
      });
    }, publish)
    .command('logout', 'Remove all credentials', (yargs) => {
      return yargs
    }, logout)
    .help()
    .demandCommand(1, 'You need to enter at least one command')
    .argv;
}

async function promptForAccessKeyId() {
  const questions = [];
  questions.push({
    type: 'input',
    name: 'accessKeyId',
    message: 'Please provide your access key id'
  });
  const answers = await inquirer.prompt(questions);
  return answers.accessKeyId;
}

async function promptForAccessKeySecret() {
  const questions = [];
  questions.push({
    type: 'input',
    name: 'accessKeySecret',
    message: 'Please provide your access key secret'
  });
  const answers = await inquirer.prompt(questions);
  return answers.accessKeySecret;
}

function determineCategory(appInfo) {
  if (!appInfo.category) {
    return ['general']
  }
  return Array.isArray(appInfo.category) ? appInfo.category : [appInfo.category];
}

function createTar(appInfo, argv) {
  log(gray('Process for creating the tar.gz file'));
  return new Promise((resolve, reject) => {
    let version = `v${appInfo.version}`;
    if (argv.latest) {
      version = 'latest';
    }
    const tarFile = `${appInfo.id}-${version}.tar.gz`;
    log(gray(`Filename determined: '${tarFile}'`));
    tar.c({
      gzip: true,
      file: tarFile,
      filter: (path, stats) => {
        if (!path.includes('node_modules')) {
          if (stats.isFile() && path.startsWith('.')) {
            return false;
          }
          if (stats.isFile() && path.includes(tarFile)) {
            return false
          }
        }
        return true;
      }
    }, [`./`]).then((_result) => {
      const hash = crypto.createHash('sha1');
      const readStream = fs.createReadStream(`${cwd()}/${tarFile}`);
      readStream.on('error', reject);
      readStream.on('data', chunk => hash.update(chunk));
      readStream.on('end', () => resolve({hash: hash.digest('hex'), filename: tarFile}));
    }, (error) => {
      reject(error);
    });
  });
}

function getI18nDescriptions() {
  const lang = {}
  fs.readdirSync(`${cwd()}/`).forEach((path) => {
    if (path.toLowerCase() === 'readme.txt') {
      lang.en = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
    } else if (path.toLowerCase().includes('readme') && path.toLowerCase().endsWith('.txt')) {
      const language = path.toLowerCase().split('.')[1];
      lang[language] = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
    }
  });
  if (Object.keys(lang).length < 1) {
    fs.readdirSync(`${cwd()}/`).forEach((path) => {
      if (path.toLowerCase() === 'readme.md') {
        lang.en = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
      } else if (path.toLowerCase().includes('readme') && path.toLowerCase().endsWith('.md')) {
        const language = path.toLowerCase().split('.')[1];
        lang[language] = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
      }
    });
  }

  return lang;
}

export async function cli(args) {
  parseArgumentsIntoOptions(args);
}

async function uploadToS3(s3Path, bucketName, root) {
  return new Promise(async resolve => {
    log(gray('Upload assets to S3'));
    let s3 = new AWS.S3();

    const overall = [];
    async function walkSync(currentDirPath, callback) {
        const promises = fs.readdirSync(currentDirPath).map((name) => {
          return new Promise(async (resolveMap) => {
            const filePath = path.join(currentDirPath, name);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              await callback(filePath, stat);
              resolveMap();
            } else if (stat.isDirectory()) {
              await walkSync(filePath, callback);
              resolveMap();
            }
          });
        });
        overall.push(...promises);
    }

    await walkSync(s3Path, (filePath, _stat) => {
      return new Promise(async (resolveWalk, rejectWalk) => {
        const bucketPath = filePath;
        const key = slash(root + bucketPath.split(s3Path)[1]).replace(/\\/g, '/');
        if (!['.svg', '.png', '.jpeg', '.jpg', '.gz'].includes(path.extname(filePath)) || filePath.includes('node_modules') || filePath.includes('.github')) {
          return resolveWalk();
        }
        const contentType = mime.contentType(path.extname(bucketPath));
        const params = {
          Bucket: bucketName,
          ACL: 'public-read',
          ContentType: contentType,
          Key: key,
          Body: fs.readFileSync(filePath)
        };
        const success = await s3.putObject(params).promise().catch(rejectWalk);
        if (!success) {
          return error(red(`Could not upload ${key}`));
        }
        log(gray('Successfully uploaded ' + bucketPath + ' to ' + bucketName + ' as ' + key));
        resolveWalk();
      });
    });

    resolve(overall);
  });
}

async function build(argv) {
  log(blue('Building the app'));
  let tar = {};
  let appInfo = {};
  try {
    log(gray(`Loading '${cwd()}/app.json'`));
    appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo, argv);
    log(gray(`${tar.filename} created successfully`));
  } catch (e) {
    error(red(e));
  }
  log(green(`Build finished: ${cwd()}/${tar.filename}`));
}

function getCredentials(account) {
  return new Promise((resolve, reject) => {
    keytar.getPassword('hcs-cli', account).then((result) => {
      resolve(result ? result : false);
    }).catch(reject);
  });
}

function setCredentials(account, password) {
  return new Promise((resolve, reject) => {
    keytar.setPassword('hcs-cli', account, password).then((_result) => {
      resolve(true);
    }).catch(reject);
  });
}

async function logout(_argv) {
  const allCreds = await keytar.findCredentials('hcs-cli');
  const promises = allCreds.map(async creds => {
    await keytar.deletePassword('hcs-cli', creds.account);
  });
  await Promise.allSettled(promises);
  log(green('You have been signed out'));
}

async function publish(argv) {
  log(blue('Publishing the app'));
  let appInfo = {};
  let tar = {};
  const force = !!argv.force;
  try {
    log(gray(`Loading '${cwd()}/app.json'`));
    appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo, argv);
    log(gray(`${tar.filename} created successfully`));
  } catch (e) {
    error(red(e));
    return;
  }

  log(gray('Process the app.json'));
  const timestamp = Date.now();
  let app = {
    id: appInfo.id,
    added: timestamp,
    modified: timestamp,
    versions: [{
      id: appInfo.id,
      summary: appInfo.description,
      hash: tar.hash,
      filename: tar.filename,
      added: timestamp,
      modified: timestamp,
      sdk: appInfo.sdk,
      version: appInfo.version,
      compatibility: appInfo.compatibility,
      name: appInfo.name,
      icon: appInfo.icon,
      brandColor: appInfo.brandColor || '#000000',
      tags: appInfo.tags,
      category: determineCategory(appInfo),
      author: appInfo.author,
      contributors: appInfo.contributors,
      source: appInfo.source,
      homepage: appInfo.homepage,
      support: appInfo.support,
      images: {
        small: appInfo.images ? appInfo.images.small : null,
        large: appInfo.images ? appInfo.images.large : null,
      },
      permissions: appInfo.permissions,
      contributing: appInfo.contributing,
      bugs: appInfo.bugs,
      homeyCommunityTopicId: appInfo.homeyCommunityTopicId,
      signals: appInfo.signals,
      flow: appInfo.flow,
      discovery: appInfo.discovery,
      drivers: appInfo.drivers,
      description: getI18nDescriptions(),
      enabled: true
    }]
  };

  log(gray('Look for ./homeychangelog.json'));
  if (fs.existsSync(`${cwd()}/.homeychangelog.json`)) {
    log(gray('Changelog found, adding it to the app'))
    app.changelog = require(`${cwd()}/.homeychangelog.json`);
    app.versions[0].changelog = require(`${cwd()}/.homeychangelog.json`);
  }

  log(gray(`Processing locales`));
  const locales = {};
  const appVersion = app.versions[0];
  if (appVersion.name) {
    log(gray(`Processing locales from the name: ${Object.keys(appVersion.name).join(', ')}`));
    Object.keys(appVersion.name).forEach(lang => {
      locales[lang] = {name: appVersion.name[lang]}
    });
  }

  if (appVersion.summary) {
    log(gray(`Processing locales from the summary for the description: ${Object.keys(appVersion.name).join(', ')}`));
    Object.keys(appVersion.summary).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.summary[lang]
      }
    });
  }

  if (appVersion.description) {
    log(gray(`Processing locales from the description for the description: ${Object.keys(appVersion.name).join(', ')}`));
    Object.keys(appVersion.description).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.description[lang]
      }
    });
  }

  if (appVersion.tags) {
    log(gray(`Processing locales from the tags: ${Object.keys(appVersion.name).join(', ')}`));
    Object.keys(appVersion.tags).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        tags: appVersion.tags[lang]
      }
    });
  }

  if (appVersion.changelog) {
    Object.keys(appVersion.changelog).forEach(version => {
      log(gray(`Processing locales from the changelog ${version}: ${Object.keys(appVersion.changelog[version]).join(', ')}`));
      Object.keys(appVersion.changelog[version]).forEach(lang => {
        if (!locales[lang]) {
          locales[lang] = {};
        }
        if (!locales[lang].changelog) {
          locales[lang].changelog = {};
        }
        locales[lang].changelog[version] = appVersion.changelog[version][lang];
      })
    });
  }

  app.versions[0].locales = locales;

  log(gray('Looking for credentials'));
  const creds = await keytar.findCredentials('hcs-cli').catch(err => error(red(err)));
  let accessKeyId;
  let accessKeySecure;
  if (creds && creds.length === 1) {
    accessKeyId = creds[0].account;
    accessKeySecure = creds[0].password;
  } else {
    log(blue('Credentials not found, please sign in'));
    accessKeyId = await promptForAccessKeyId();
    accessKeySecure = await getCredentials(accessKeyId).catch(err => error(red(err)));
  }

  if (accessKeySecure === false) {
    //ask for credentials;
    log(blue('Password not found, please sign in'));
    const accessKeySecret = await promptForAccessKeySecret();
    if (accessKeySecret) {
      const success = await setCredentials(accessKeyId, accessKeySecret).catch(err => error(red(err)));
      if (!success) {
        error(red('Something went wrong storing your credentials'));
        return;
      }
    } else {
      return;
    }
    accessKeySecure = accessKeySecret;
  }

  log(gray('Creating the AWS Config'));
  AWS.config = new AWS.Config({
    region: 'eu-central-1',
    accessKeyId: accessKeyId,
    secretAccessKey: accessKeySecure
  });

  const request = {
    host: '4c23v5xwtc.execute-api.eu-central-1.amazonaws.com',
    method: 'POST',
    url: `https://4c23v5xwtc.execute-api.eu-central-1.amazonaws.com/production/apps/publish`,
    data: {app, force}, // object describing the foo
    body: JSON.stringify({app, force}), // aws4 looks for body; axios for data
    path: `/production/apps/publish`,
    headers: {
      'content-type': 'application/json'
    }
  }
  log(gray(`Preparing request to the API ${request.url}`));

  const signedRequest = aws4.sign(request,
    {
      secretAccessKey: AWS.config.credentials.secretAccessKey,
      accessKeyId: AWS.config.credentials.accessKeyId
    })

  delete signedRequest.headers['Host'];
  delete signedRequest.headers['Content-Length'];

  log(gray(`Send request to the API ${request.url}`));
  const response = await axios(signedRequest).catch(err => error(red(err)));
  if (response && response.data && response.data.body) {
    const {success, msg} = response.data.body;
    if (!success) {
      error(red(msg));
      return;
    }
    log(gray(msg));

    const uploadPromise = uploadToS3(cwd(), 'homey-community-store', `${app.id}/${appInfo.version}`);
    const filePromises = await uploadPromise;
    if (filePromises){
      let errors;
      await Promise.allSettled(filePromises).catch(err => errors = err);
      if (errors) {
        log(red('Failed to push an asset to the S3 storage. Failed to publish the app. Please contact the HCS admin'));
      } else {
        log(green('Successfully published the app to the Homey Community Store.'));
      }
    } else {
      error(red('FAILED TO PUBLISH'));
    }


  } else {
    error(red('Failed pushing to the DB'));
    error(red(response.statusText));
  }
}
