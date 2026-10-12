import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicAddress,validateUrl} from '../agent/lib/policy.ts';
test('blocks private, loopback, metadata, mapped IPv6 and reserved targets',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700::1111']) assert.equal(publicAddress(ip),true,ip);
});
test('rejects unsafe protocols, credentials, ports and non-allowlisted hosts',async()=>{
 for(const url of ['file:///etc/passwd','http://127.0.0.1','https://user:pass@example.com','https://example.com:8443'])await assert.rejects(validateUrl(url));
 await assert.rejects(validateUrl('https://example.com','other.example'));
});
