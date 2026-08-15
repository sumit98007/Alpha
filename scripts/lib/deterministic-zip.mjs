import { crc32 } from './crc32.mjs';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01, the earliest date supported by ZIP.

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertEntryName(name) {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').includes('..') ||
    name.includes('\0')
  ) {
    throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
  }
}

function localHeader(name, data, checksum) {
  const encodedName = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + encodedName.length);
  header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORED_METHOD, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(encodedName.length, 26);
  header.writeUInt16LE(0, 28);
  encodedName.copy(header, 30);
  return header;
}

function centralHeader(name, data, checksum, localOffset) {
  const encodedName = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46 + encodedName.length);
  header.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORED_METHOD, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(encodedName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  encodedName.copy(header, 46);
  return header;
}

export function createDeterministicZip(entries) {
  const sortedEntries = [...entries]
    .map(({ name, data }) => ({ name, data: Buffer.from(data) }))
    .sort((left, right) => compareNames(left.name, right.name));

  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of sortedEntries) {
    assertEntryName(entry.name);
    if (names.has(entry.name)) {
      throw new Error(`Duplicate ZIP entry: ${entry.name}`);
    }
    names.add(entry.name);

    const checksum = crc32(entry.data);
    const header = localHeader(entry.name, entry.data, checksum);
    localParts.push(header, entry.data);
    centralParts.push(centralHeader(entry.name, entry.data, checksum, localOffset));
    localOffset += header.length + entry.data.length;
  }

  if (sortedEntries.length > 0xffff) {
    throw new Error(
      'ZIP64 is intentionally unsupported. The extension package has too many files.'
    );
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sortedEntries.length, 8);
  end.writeUInt16LE(sortedEntries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readDeterministicZip(archive) {
  const input = Buffer.from(archive);
  if (input.length < 22 || input.readUInt32LE(input.length - 22) !== END_SIGNATURE) {
    throw new Error('Invalid or commented ZIP archive.');
  }

  const endOffset = input.length - 22;
  const entryCount = input.readUInt16LE(endOffset + 10);
  const centralSize = input.readUInt32LE(endOffset + 12);
  const centralOffset = input.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error('Invalid ZIP central-directory bounds.');
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize) {
      throw new Error('Truncated ZIP central-directory entry.');
    }
    if (input.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error('Invalid ZIP central-directory entry.');
    }

    const method = input.readUInt16LE(cursor + 10);
    const checksum = input.readUInt32LE(cursor + 16);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const uncompressedSize = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentLength;
    if (nextCursor > centralOffset + centralSize) {
      throw new Error('Invalid ZIP central-directory entry bounds.');
    }
    const name = input.subarray(nameStart, nameStart + nameLength).toString('utf8');
    assertEntryName(name);

    if (method !== STORED_METHOD || compressedSize !== uncompressedSize) {
      throw new Error(`Unsupported compression method for ${name}.`);
    }
    if (entries.has(name)) {
      throw new Error(`Duplicate ZIP entry: ${name}`);
    }
    if (
      localOffset + 30 > centralOffset ||
      input.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE
    ) {
      throw new Error(`Invalid local ZIP header for ${name}.`);
    }

    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localName = input
      .subarray(localNameStart, localNameStart + localNameLength)
      .toString('utf8');
    if (localName !== name) {
      throw new Error(`ZIP filename mismatch for ${name}.`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + uncompressedSize > centralOffset) {
      throw new Error(`Invalid local ZIP data bounds for ${name}.`);
    }
    const data = input.subarray(dataStart, dataStart + uncompressedSize);
    if (data.length !== uncompressedSize || crc32(data) !== checksum) {
      throw new Error(`Corrupt ZIP entry: ${name}.`);
    }

    entries.set(name, Buffer.from(data));
    cursor = nextCursor;
  }

  if (cursor !== centralOffset + centralSize) {
    throw new Error('ZIP central-directory size mismatch.');
  }
  return entries;
}
