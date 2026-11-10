/**
 * UpdateService default network implementations (requestJson, downloadFile)
 */

import { PassThrough } from 'stream';

const mockRequest = jest.fn();
jest.mock('https', () => ({
  request: (...args: any[]) => mockRequest(...args),
}));

const mockCreateWriteStream = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
  };
});

jest.mock('vscode', () => ({
  Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
  commands: { executeCommand: jest.fn().mockResolvedValue(undefined) },
}), { virtual: true });

import { UpdateService } from '../UpdateService';

function makeReqRes(statusCode: number, _body: any, headers: any = {}) {
  const req: any = new PassThrough();
  req.end = jest.fn();
  const res: any = new PassThrough();
  res.statusCode = statusCode;
  res.headers = headers;
  res.setEncoding = jest.fn();
  return { req, res };
}

describe('UpdateService default network', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requestJson fetches and parses release JSON', async () => {
    mockRequest.mockImplementation((_url: string, _opts: any, cb: any) => {
      const { req, res } = makeReqRes(200, null);
      process.nextTick(() => {
        cb(res);
        res.emit('data', JSON.stringify({
          tag_name: 'v0.2.0',
          name: 'Release',
          body: 'notes',
          assets: [{ name: 'app.vsix', browser_download_url: 'https://example.com/app.vsix' }],
        }));
        res.emit('end');
      });
      return req;
    });

    const service = new UpdateService({ currentVersion: '0.1.0' });
    const release = await service.getLatestRelease();
    expect(release?.version).toBe('0.2.0');
    expect(release?.vsixUrl).toBe('https://example.com/app.vsix');
  });

  it('requestJson rejects on non-200 and invalid JSON', async () => {
    mockRequest.mockImplementationOnce((_url: string, _opts: any, cb: any) => {
      const { req, res } = makeReqRes(500, null);
      process.nextTick(() => { cb(res); res.emit('end'); });
      return req;
    });
    const service = new UpdateService({ currentVersion: '0.1.0' });
    await expect(service.getLatestRelease()).rejects.toThrow('GitHub returned HTTP 500');

    mockRequest.mockImplementationOnce((_url: string, _opts: any, cb: any) => {
      const { req, res } = makeReqRes(200, null);
      process.nextTick(() => { cb(res); res.emit('data', '{bad'); res.emit('end'); });
      return req;
    });
    const service2 = new UpdateService({ currentVersion: '0.1.0' });
    await expect(service2.getLatestRelease()).rejects.toThrow('invalid release metadata');
  });

  it('requestJson rejects on request error', async () => {
    mockRequest.mockImplementation((_url: string, _opts: any, _cb: any) => {
      const req: any = new PassThrough();
      req.end = jest.fn();
      process.nextTick(() => req.emit('error', new Error('net fail')));
      return req;
    });
    const service = new UpdateService({ currentVersion: '0.1.0' });
    await expect(service.getLatestRelease()).rejects.toThrow('net fail');
  });

  it('downloadFile returns download error on non-200', async () => {
    const actualFs = jest.requireActual('fs') as typeof import('fs');
    const os = require('os');
    const path = require('path');
    const target = path.join(os.tmpdir(), `cv-dl-${Date.now()}.vsix`);

    mockCreateWriteStream.mockImplementation(() => {
      const ws = actualFs.createWriteStream(target);
      const origClose = ws.close.bind(ws);
      ws.close = (cb?: any) => origClose(cb);
      return ws;
    });
    mockRequest.mockImplementation((_url: string, _opts: any, cb?: any) => {
      if (typeof _opts === 'function') { cb = _opts; }
      const req: any = new PassThrough(); req.end = jest.fn();
      const res: any = new PassThrough(); res.headers = {}; res.setEncoding = jest.fn();
      res.statusCode = 404;
      process.nextTick(() => cb(res));
      return req;
    });
    const service = new UpdateService({ currentVersion: '0.1.0' });
    await expect(service.install({
      version: '0.2.0', tagName: 'v0.2.0', name: 'R', body: '', vsixUrl: 'https://example.com/app.vsix',
    })).rejects.toThrow('VSIX download returned HTTP 404');
    try { actualFs.unlinkSync(target); } catch {}
  });

  it('downloadFile emits request error', async () => {
    const actualFs = jest.requireActual('fs') as typeof import('fs');
    const os = require('os');
    const path = require('path');
    const target = path.join(os.tmpdir(), `cv-dl-${Date.now()}.vsix`);

    mockCreateWriteStream.mockImplementation(() => {
      const ws = actualFs.createWriteStream(target);
      const origClose = ws.close.bind(ws);
      ws.close = (cb?: any) => origClose(cb);
      return ws;
    });
    mockRequest.mockImplementation((_url: string, _opts: any, _cb?: any) => {
      if (typeof _opts === 'function') { _cb = _opts; }
      const req: any = new PassThrough(); req.end = jest.fn();
      process.nextTick(() => req.emit('error', new Error('dl fail')));
      return req;
    });
    const service = new UpdateService({ currentVersion: '0.1.0' });
    await expect(service.install({
      version: '0.2.0', tagName: 'v0.2.0', name: 'R', body: '', vsixUrl: 'https://example.com/app.vsix',
    })).rejects.toThrow('dl fail');
    try { actualFs.unlinkSync(target); } catch {}
  });
});
