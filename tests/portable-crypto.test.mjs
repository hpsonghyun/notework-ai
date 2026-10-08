import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {sha256HexSync,sha256Hex,utf8ByteLength,encodeBase64,decodeBase64,randomUUID} from '../src/portable-crypto.mjs';

const oracle=value=>createHash('sha256').update(value).digest('hex');
test('portable synchronous SHA-256 matches published vectors and desktop UTF-8 behavior',()=>{
  for(const [input,expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])assert.equal(sha256HexSync(input),expected);
  for(const input of ['한국어 지식 그래프 🧠\r\n', '\ud800', '\udc00', 'A\ud800B\udc00C', '\0\u2028\u2029', JSON.stringify({path:'연구/메모.md',start:0,end:1800})]){
    assert.equal(sha256HexSync(input),oracle(input));assert.equal(utf8ByteLength(input),Buffer.byteLength(input));
  }
  assert.throws(()=>utf8ByteLength({}),TypeError);assert.throws(()=>sha256HexSync({}),TypeError);
});
test('SHA-256 padding boundaries and ArrayBuffer view offsets retain identical desktop hashes',()=>{
  for(const length of [0,1,2,3,55,56,57,63,64,65,119,120,127,128,129,1024,65536]){
    const bytes=Uint8Array.from({length},(_,at)=>(at*47+13)%256);assert.equal(sha256HexSync(bytes),oracle(bytes));assert.equal(sha256HexSync(bytes.buffer),oracle(bytes));
  }
  const backing=Uint8Array.from([0,1,2,3,4,5,6,7]);const view=new DataView(backing.buffer,2,3);assert.equal(sha256HexSync(view),oracle(backing.subarray(2,5)));assert.equal(encodeBase64(view),Buffer.from(backing.subarray(2,5)).toString('base64'));
});
test('asynchronous hashing uses browser WebCrypto and deterministic fallback without Node globals',async()=>{
  for(const input of ['abc','한글 🧠',new Uint8Array([0,255,9])]){assert.equal(await sha256Hex(input,{cryptoImpl:webcrypto}),oracle(input));assert.equal(await sha256Hex(input,{cryptoImpl:{}}),oracle(input));}
  let called=0;const subtle={digest:async function(algorithm,input){called++;assert.equal(this,subtle);assert.equal(algorithm,'SHA-256');assert.equal(new TextDecoder().decode(input),'abc');return webcrypto.subtle.digest(algorithm,input);}};
  assert.equal(await sha256Hex('abc',{cryptoImpl:{subtle}}),oracle('abc'));assert.equal(called,1);
  await assert.rejects(sha256Hex('abc',{cryptoImpl:{subtle:{digest:async()=>{throw new Error('digest unavailable');}}}}),/digest unavailable/);
});
test('portable base64 preserves canonical desktop payload bytes across UTF-8 and large archives',()=>{
  for(const input of ['', 'a','ab','abc','abcd','한국어 🧠\r\n', '\ud800', 'Markdown source\n'.repeat(10000)]){
    const expected=Buffer.from(input).toString('base64');assert.equal(encodeBase64(input),expected);assert.deepEqual(decodeBase64(expected),new TextEncoder().encode(input));
  }
  const input=Uint8Array.from({length:256},(_,at)=>at);assert.equal(encodeBase64(input),Buffer.from(input).toString('base64'));assert.deepEqual(decodeBase64(encodeBase64(input)),input);
});
test('base64 rejects malformed or noncanonical data rather than decoding ambiguous archive bytes',()=>{
  for(const value of ['A','AA','AAA','AAAA=','A===','====','=AAA','AA=A','AB==','AAB=','AA==\n',' AABB','AABB ','A-B_','🧠',null,17])assert.throws(()=>decodeBase64(value),TypeError,String(value));
  for(const value of ['','AA==','AAA=','AAAA','////','/w==','//8='])assert.equal(encodeBase64(decodeBase64(value)),value);
});
test('secure UUID generation uses native browser IDs or getRandomValues with RFC version and variant',()=>{
  const native={randomUUID:function(){assert.equal(this,native);return'00112233-4455-4677-8899-aabbccddeeff';}};assert.equal(randomUUID({cryptoImpl:native}),'00112233-4455-4677-8899-aabbccddeeff');
  let calls=0;const fallback={getRandomValues:function(bytes){calls++;assert.equal(this,fallback);assert.equal(bytes.byteLength,16);bytes.fill(255);return bytes;}};assert.equal(randomUUID({cryptoImpl:fallback}),'ffffffff-ffff-4fff-bfff-ffffffffffff');assert.equal(calls,1);
  assert.throws(()=>randomUUID({cryptoImpl:{}}),/Secure random IDs are unavailable/);assert.throws(()=>randomUUID({cryptoImpl:null}),/Secure random IDs are unavailable/);
});
