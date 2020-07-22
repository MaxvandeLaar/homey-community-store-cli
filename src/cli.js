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

function parseArgumentsIntoOptions(rawArgs) {
  return yargs
    .usage('Usage: hcs <command> [options]')
    .command('build', 'Create a tar.gz file for the app', build)
    .command('publish', 'Build the app and upload it to the Homey Community Store', publish)
    .demandCommand(1, 'You need to enter at least one command')
    .help()
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
  return {accessKey: answers.accessKeyId};
}

async function promptForAccessKeySecret() {
  const questions = [];
  questions.push({
    type: 'input',
    name: 'accessKeySecret',
    message: 'Please provide your access key secret'
  });
  const answers = await inquirer.prompt(questions);
  return {accessKey: answers.accessKeySecret};
}

function determineCategory(appInfo) {
  if (!appInfo.category) {
    return ['general']
  }
  return Array.isArray(appInfo.category) ? appInfo.category : [appInfo.category];
}

function createTar(appInfo) {
  return new Promise((resolve, reject) => {
    const tarFile = `${appInfo.id}-v${appInfo.version}.tar.gz`;
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
    }, [`./`]).then((result) => {
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

function uploadToS3(s3Path, bucketName, root) {
  let s3 = new AWS.S3();

  function walkSync(currentDirPath, callback) {
    fs.readdirSync(currentDirPath).forEach((name) => {
      const filePath = path.join(currentDirPath, name);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        callback(filePath, stat);
      } else if (stat.isDirectory()) {
        walkSync(filePath, callback);
      }
    });
  }

  walkSync(s3Path, (filePath, stat) => {
    const bucketPath = filePath;
    const key = root + bucketPath.split(s3Path)[1];
    if (!['.svg', '.png', '.jpeg', '.jpg', '.gz'].includes(path.extname(filePath)) || filePath.includes('node_modules') || filePath.includes('.github')) {
      return;
    }
    const contentType = mime.contentType(path.extname(bucketPath));
    let params = {
      Bucket: bucketName,
      ACL: 'public-read',
      ContentType: contentType,
      Key: key,
      Body: fs.readFileSync(filePath)
    };
    s3.putObject(params, function (err, data) {
      if (err) {
        console.log(err)
      } else {
        console.log('Successfully uploaded ' + bucketPath + ' to ' + bucketName);
      }
    });
  });
}

function putAppDB(app) {
  const DB = new AWS.DynamoDB();
  const marshalled = AWS.DynamoDB.Converter.marshall(app);
  const params = {
    Item: marshalled,
    ReturnConsumedCapacity: "TOTAL",
    TableName: "HomeyCommunityStore"
  };
  return DB.putItem(params).promise();
}

function updateAppDB(app, version) {
  const DB = new AWS.DynamoDB.DocumentClient();
  let changelog = '';
  let ExpressionAttributeNames = {
    '#versions': 'versions',
    '#modified': 'modified'
  };

  let ExpressionAttributeValues = {
    ':version': [version],
    ':modified': Date.now(),
    ':empty_list': []
  }

  if (version.changelog) {
    changelog = ', #changelog = :changelog';
    ExpressionAttributeNames = {
      ...ExpressionAttributeNames,
      '#changelog': 'changelog'
    };
    ExpressionAttributeValues = {
      ...ExpressionAttributeValues,
      ':changelog': version.changelog
    };
  }

  return DB.update({
    TableName: 'HomeyCommunityStore',
    Key: {
      id: app.id
    },
    ReturnValues: 'ALL_NEW',
    UpdateExpression: 'set #versions = list_append(if_not_exists(#versions, :empty_list), :version), #modified = :modified' + changelog,
    ExpressionAttributeNames,
    ExpressionAttributeValues
  }).promise()
}

function getExistingApp(dynamoDB, app) {
  const params = {
    TableName: "HomeyCommunityStore",
    Key: {
      id: {
        S: app.id
      }
    }
  };
  return new Promise((resolve, reject) => {
    dynamoDB.getItem(params, function (err, data) {
      if (err) {
        return reject(err);
      }

      if (Object.keys(data).length < 1) {
        return resolve({new: true});
      }
      if (data.Item) {
        return resolve({new: false, item: AWS.DynamoDB.Converter.unmarshall(data.Item)});
      } else {
        reject();
      }
    });
  });
}

async function build() {
  console.log('Building the app');
  let tar = {};
  try {
    const appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo);
  } catch (e) {
    console.error(e);
    return;
  }
  console.log(`Build finished: ${cwd()}/${tar.filename}`)
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
    keytar.setPassword('hcs-cli', account, password).then((result) => {
      resolve(true);
    }).catch(reject);
  });
}

async function publish() {
  let appInfo = {};
  let tar = {};
  try {
    appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo);
  } catch (e) {
    console.error(e);
    return;
  }

  let app = {
    id: appInfo.id,
    added: Date.now(),
    modified: Date.now(),
    versions: [{
      id: appInfo.id,
      summary: appInfo.description,
      hash: tar.hash,
      filename: tar.filename,
      added: Date.now(),
      modified: Date.now(),
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

  if (fs.existsSync(`${cwd()}/.homeychangelog.json`)) {
    app.changelog = require(`${cwd()}/.homeychangelog.json`);
    app.versions[0].changelog = require(`${cwd()}/.homeychangelog.json`);
  }

  const locales = {};
  const appVersion = app.versions[0];
  if (appVersion.name) {
    Object.keys(appVersion.name).forEach(lang => {
      locales[lang] = {name: appVersion.name[lang]}
    });
  }

  if (appVersion.summary) {
    Object.keys(appVersion.summary).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.summary[lang]
      }
    });
  }

  if (appVersion.description) {
    Object.keys(appVersion.description).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.description[lang]
      }
    });
  }

  if (appVersion.tags) {
    Object.keys(appVersion.tags).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        tags: appVersion.tags[lang]
      }
    });
  }
  if (appVersion.changelog) {

    Object.keys(appVersion.changelog).forEach(version => {
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

  const accessKeyId = await promptForAccessKeyId();

  let accessKeySecure = await getCredentials(accessKeyId).catch(console.error);
  if (!accessKeySecure) {
    console.error('Please provide your access key id');
    return;
  }

  if (accessKeySecure === false) {
    //ask for credentials;
    const creds = await promptForAccessKeySecret();
    if (creds.accessKeySecret) {
      const success = await setCredentials(accessKeyId, creds.accessKey).catch(console.error);
      if (!success) {
        console.log('Something went wrong storing your credentials');
        return;
      }
      accessKeySecure = creds.accessKey;
    } else {
      return;
    }
  }

  AWS.config = new AWS.Config({
    region: 'eu-central-1',
    accessKeyId: accessKeySecure,
    secretAccessKey: accessKeyId
  });

  const dynamoDB = new AWS.DynamoDB();
  let dbCheck;
  try {
    dbCheck = await getExistingApp(dynamoDB, app);
  } catch (e) {
    console.error(e);
    return;
  }

  if (dbCheck.new) {
    //Add app to DynamoDB
    try {
      await putAppDB(app);
    } catch (e) {
      console.error(e);
      return;
    }
  } else {
    //Update APP
    let versionExists = false;
    dbCheck.item.versions.forEach((version) => {
      if (version.version === appInfo.version) {
        versionExists = true;
      }
    });

    if (versionExists) {
      console.log('This version already exists in the store!');
      return;
    }
    try {
      await updateAppDB(dbCheck.item, app.versions[0]);
    } catch (e) {
      console.error(e);
      return;
    }
  }

  //PUSH TAR FILE AND IMAGES TO S3!
  uploadToS3(cwd(), 'homey-community-store', `${app.id}/${appInfo.version}`);
}
