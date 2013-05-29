# FTP Client

This is a simple FTP lib based on the [Chrome packaged apps samples](https://github.com/GoogleChrome/chrome-app-samples) using Boris Smus's TcpClient class.

```javascript
	// Host and credentials
	var host = "foo.com";
	var user = "bar";
	var password = "foobar";
	var port = 21;

	var ftpClient = new FtpClient(host, port, user, password);

	// Connect
	ftpClient.connect()
		// List directory contents
		.then(ftpClient.list.bind(ftpClient))
		.then(function(files) {
			var deferred = Q.defer();
			var hasSample = false;

			// Look to see if sample folder exists
			files.forEach(function(file) {
				if (file.name === "sample") {
					hasSample = true;
					return false;
				}
			});

			// Create a folder if one doesn't exist
			if (!hasSample) {
				ftpClient._mkd("./sample").then(deferred.resolve);
			} else {
				deferred.resolve();
			}

			return deferred.promise;
		})

		// Create some content
		.then(ftpClient.upload.bind(ftpClient, "./sample/test.txt", "Hello World!"))

		// Download then upload it back as copy
		.then(ftpClient.download.bind(ftpClient, "./sample/test.txt"))
		.then(ftpClient.upload.bind(ftpClient, "./sample/test copy.txt"))

		// Rename the copied file
		.then(ftpClient.rename.bind(ftpClient, "/sample/test.txt", "/sample/hello.txt"))

		// Disconnect
		.then(ftpClient.disconnect.bind(ftpClient));
```

## Resources

* [FTP RFC](http://tools.ietf.org/html/rfc959)
