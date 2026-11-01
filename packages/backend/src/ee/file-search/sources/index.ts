// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import type { FileSearchProtocol } from '../../../file-search/file-search.types';
import { FtpDriver } from './ftp.driver';
import { LocalDriver } from './local.driver';
import { S3Driver } from './s3.driver';
import { SftpDriver } from './sftp.driver';
import { WebdavDriver } from './webdav.driver';
import type { FileSourceDriver } from './source.types';

const sftp = new SftpDriver();
const ftp = new FtpDriver();
const webdav = new WebdavDriver();
const local = new LocalDriver();
const s3 = new S3Driver();

export function driverFor(protocol: FileSearchProtocol): FileSourceDriver {
  switch (protocol) {
    case 'sftp':
      return sftp;
    case 'ftp':
    case 'ftps':
    case 'ftps-implicit':
      return ftp;
    case 'webdav':
      return webdav;
    case 'local':
      return local;
    case 's3':
      return s3;
  }
}
