## For Dojo seekers

> **Don't delete your wallet without your passphrase**
>
> Your [Ashigaru](http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/) or [Samourai](https://web.archive.org/web/20240424023506/https://samouraiwallet.com/) passphrase is shown only once, when the wallet is created, and is separate from the PIN you use to open the app; the two are not linked. To switch the Dojo your wallet connects to you must delete and re-create the wallet, so confirm you have the correct passphrase first. The passphrase cannot be recovered, and you need both the 12-word seed phrase and the passphrase to restore a wallet. To check a passphrase, go to **Settings → Wallet → Check BIP39 Passphrase**.
>
> 🔴 No passphrase: do not delete the wallet. Send the funds to a wallet you control instead.
>
> 🟢 Passphrase and 12 words: you can safely delete the wallet to change device or connect to another Dojo.
>
> If you have the passphrase but not the 12 words, you can still open the wallet by decrypting the backup file with the passphrase. If you lose the Dojo connection and don't have the passphrase, export the XPUB to Sparrow for a watch-only wallet and sign offline from [Ashigaru](http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/).

### Who is responsible for the listed nodes?

Not The Dojo Bay: this site is a **directory only**. We do not operate the nodes listed here, we cannot guarantee their uptime, honesty or safety, and we accept no responsibility for them or for any loss of funds or privacy. Status and reliability figures come from automated checks and can be wrong or out of date. Treat every listing as untrusted: verify the pairing details, prefer self-hosting, and connect at your own risk.

### Are there privacy concerns for Dojo seekers?

Yes. When you pair with a Dojo you share your extended public key (XPUB), and the operator can use it to view your past, present and future transactions. Only connect to a Dojo you consider reputable and trustworthy, and prefer your own node whenever possible.

### How do I verify a signed Dojo?

Confirm the PayNym belongs to someone whose reputation you can check, whether stated in a social-media bio, on their own site, or mentioned publicly, and look it up in the [PayNym.rs](http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion) directory to see its code. Then take the signed message to the [BIP47 Message Verifier](http://ab64uow264ohynkalvlyhdrduwwl75n4urvc2vrbo3xjd4jycygiirqd.onion/lab) and fill in the fields; a correct message returns "Message verified successfully". If verification fails there, use **Tools → Verify message** inside [Samourai](https://web.archive.org/web/20240424023506/https://samouraiwallet.com/) or [Ashigaru](http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/).

### Where do I learn to run my own Dojo?

A Dojo can be installed several ways: [RoninDojo](https://ronindojo.io), a vanilla Dojo (instructions at [dojo-osp.org](https://dojo-osp.org)), or through the [Umbrel](https://apps.umbrel.com/app/samourai-server), [Nodl](https://nodl.eu) and [Start9](https://marketplace.start9.com) marketplaces. It runs on almost any Bitcoin node implementation, giving you full control of your [Samourai](https://web.archive.org/web/20240424023506/https://samouraiwallet.com/) / [Ashigaru](http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/) backend. Treat any public Dojo as strictly temporary or for testing: once your own node is running, migrate your funds to fresh addresses managed by your instance to avoid reusing previously exposed public keys.

## For Dojo runners

### Are there privacy concerns for Dojo runners?

Not security concerns so much as exposure ones. By sharing a pairing payload you reveal your Dojo's onion address, which a malicious party could try to DDoS. You also risk a large number of wallets pairing to your Dojo, so size your hardware accordingly. Until API-key management is fully in place you cannot un-share your pairing details once published.

### Can I change the onion address if I'm being DDoSed?

Yes, but you will have to re-pair every connected wallet.

### Can I see how many wallets are connected to my Dojo?

No, and that will not be possible.

### Can I cap the number if my hardware is limited?

It isn't really about connections but about tracking a very large number of addresses, and that limit is high even on lower-grade devices.
