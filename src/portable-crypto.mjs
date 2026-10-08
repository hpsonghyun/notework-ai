// Browser-native primitives, including a synchronous SHA-256 for existing IDs and
// Obsidian vault.process callbacks. Padding, schedules and rounds follow FIPS 180-4.
const K=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE=new Int16Array(128).fill(-1);for(let at=0;at<ALPHABET.length;at++)DECODE[ALPHABET.charCodeAt(at)]=at;
const rotate=(value,count)=>(value>>>count)|(value<<(32-count));
function bytes(value){if(typeof value==='string')return new TextEncoder().encode(value);if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);if(value instanceof ArrayBuffer)return new Uint8Array(value);throw new TypeError('Use text or bytes for a local cryptographic operation.');}
export function utf8ByteLength(value){if(typeof value!=='string')throw new TypeError('Use text to measure UTF-8 bytes.');return new TextEncoder().encode(value).byteLength;}

/** Exactly the SHA-256 hexadecimal digest used by prior desktop versions. */
export function sha256HexSync(value){
  const input=bytes(value),length=input.byteLength;const data=new Uint8Array(Math.ceil((length+9)/64)*64);data.set(input);data[length]=0x80;const view=new DataView(data.buffer);
  view.setUint32(data.length-8,Math.floor(length/0x20000000),false);view.setUint32(data.length-4,(length*8)>>>0,false);
  const hash=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);const schedule=new Uint32Array(64);
  for(let offset=0;offset<data.length;offset+=64){
    for(let at=0;at<16;at++)schedule[at]=view.getUint32(offset+at*4,false);
    for(let at=16;at<64;at++){const a=schedule[at-15],b=schedule[at-2];schedule[at]=(schedule[at-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+schedule[at-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=hash;
    for(let at=0;at<64;at++){
      const first=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[at]+schedule[at])>>>0;
      const second=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
    }
    const next=[a,b,c,d,e,f,g,h];for(let at=0;at<8;at++)hash[at]=(hash[at]+next[at])>>>0;
  }
  return Array.from(hash,word=>word.toString(16).padStart(8,'0')).join('');
}

/** Prefer WebCrypto for asynchronous work; preserve deterministic hashes without it. */
export async function sha256Hex(value,{cryptoImpl=globalThis.crypto}={}){
  const input=bytes(value);if(typeof cryptoImpl?.subtle?.digest==='function'){
    const digest=await cryptoImpl.subtle.digest('SHA-256',input);
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  return sha256HexSync(input);
}

/** Canonical padded base64 without Node Buffer or large spread/argument lists. */
export function encodeBase64(value){
  const input=bytes(value);const parts=[];let block='';
  for(let at=0;at<input.length;at+=3){const a=input[at],b=input[at+1],c=input[at+2];block+=ALPHABET[a>>>2]+ALPHABET[((a&3)<<4)|((b??0)>>>4)]+(b===undefined?'=':ALPHABET[((b&15)<<2)|((c??0)>>>6)])+(c===undefined?'=':ALPHABET[c&63]);if(block.length>=16384){parts.push(block);block='';}}
  if(block)parts.push(block);return parts.join('');
}
export function decodeBase64(value){
  if(typeof value!=='string'||value.length%4||/[^A-Za-z0-9+/=]/.test(value))throw new TypeError('Use canonical base64 data.');
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  if(value.slice(0,value.length-padding).includes('='))throw new TypeError('Use canonical base64 data.');
  const out=new Uint8Array(value.length/4*3-padding);let next=0;
  for(let at=0;at<value.length;at+=4){const a=DECODE[value.charCodeAt(at)],b=DECODE[value.charCodeAt(at+1)],c=value[at+2]==='='?0:DECODE[value.charCodeAt(at+2)],d=value[at+3]==='='?0:DECODE[value.charCodeAt(at+3)];if(a<0||b<0||c<0||d<0)throw new TypeError('Use canonical base64 data.');out[next++]=(a<<2)|(b>>>4);if(next<out.length)out[next++]=(b<<4)|(c>>>2);if(next<out.length)out[next++]=(c<<6)|d;}
  if(value.length&&(padding===2&&(DECODE[value.charCodeAt(value.length-3)]&15)||padding===1&&(DECODE[value.charCodeAt(value.length-2)]&3)))throw new TypeError('Use canonical base64 data.');
  return out;
}

/** Secure browser UUID fallback; never substitute predictable Math.random IDs. */
export function randomUUID({cryptoImpl=globalThis.crypto}={}){
  if(typeof cryptoImpl?.randomUUID==='function')return cryptoImpl.randomUUID();
  if(typeof cryptoImpl?.getRandomValues!=='function')throw new Error('Secure random IDs are unavailable. Reopen Obsidian on a supported device.');
  const value=new Uint8Array(16);cryptoImpl.getRandomValues(value);value[6]=(value[6]&15)|64;value[8]=(value[8]&63)|128;
  const hex=Array.from(value,byte=>byte.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
