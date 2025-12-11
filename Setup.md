# Setup Guide

## General Instructions
1. Install and start Coppeliasim EDU Version 4.10
2. Install and start docker and docker compose
3. Start the docker compose file with `docker compose up`

## Ubuntu 24.04
The following steps describe in detail how to setup the environment on Ubuntu 24.04, but it should work similar on other operating systems.

### 1. Install Coppelia Sim
- Go to https://www.coppeliarobotics.com and download the Edu version of CoppeliaSim (**V4.10!**). $\rightarrow$ a zip file will be downloaded.
- If a newer version than 4.10 is already available in your Downloads folder, go to "Download previous versions" at the very bottom of the CoppeliaSim homepage.
- Extract the zip file to the desired installation folder for CoppeliaSim.
- Open the Terminal in the folder containing the extracted CoppeliaSim files.
- Add execution permissions:
`   chmod +x coppeliaSim.sh , chmod +x coppeliaSim`

### 2. Install Node.js/ts-node

#### Update package list
- `sudo apt update`

#### Install Node.js
- `sudo apt install nodejs npm`


#### Check versions (should all output a version number in the Terminal upon successful installation)
- `node -v`
- `npm -v`

### Install TD Directory
There are two ways of installing and running the TD directory.
You can use a docker container, or run a execute a binary. 
To use the binary follow the steps described in the `readme.md` in `td-directory-binary`.
To use the docker way, do the following: 
#### 3. Install Docker
#### Update package lists
- `sudo apt update`
- `sudo apt install apt-transport-https ca-certificates curl software-properties-common`
### Add Docker GPG key
- `curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg`
### Add Docker Repo to the apt package source
- `echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`
### Install Docker
- `sudo apt update`
- `sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
### Verify installation
- `sudo docker run hello-world`
## Check if Docker compose was also installed
- `docker compose version`
### Optional: Add user to the Docker group (no more sudo needed)
- `sudo usermod -aG docker $USER`
- `Restart PC`
- `Run docker run hello-world and check if it works`

## 4. Clone Repository
- Clone the Deliverable Repository
- Run `npm install` in the repository root folder to download the required packages. (Optionally: Run `npm audit fix` afterwards to resolve vulnerabilities).

## 5. Open Virtual Scene in Coppelia Sim
- Open the folder containing CoppeliaSim in the Terminal.
- Execute `./coppeliaSim.sh` $\rightarrow$ CoppeliaSim starts.
- In CoppeliaSim, go to File $\rightarrow$ Open Scene, navigate to `./TaskAssets`, and open `IoT_Remote_Lab.ttt` $\rightarrow$ The scene should open in CoppeliaSim.

# Notes:

- Don't run multiple scenes and corresponding servers at the same time, which will cause port conflict.
- Make sure that no docker container for the TD Directory is actively running when starting/restarting CoppeliaSim. You can do this by executing **`docker compose down`** and afterwards **`docker compose up`**.
